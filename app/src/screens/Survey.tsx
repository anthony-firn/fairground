/**
 * Audience surveys in the app. Followers see a plain-language invitation; answers leave the device one at a time, at
 * random moments, from throwaway keys. Creators issue tokens automatically whenever they open the app, and see the
 * same recount an advertiser would.
 */
import { useEffect, useState } from 'react';
import { base64 } from '@scure/base';
import type { Event } from 'nostr-tools/pure';
import { KIND } from '@core/kinds.ts';
import {
  answerTimes,
  createAnswer,
  createSurvey,
  finalizeTokens,
  issueTokens,
  parseSurvey,
  requestTokens,
  STANDARD_QUESTIONS,
  tallySurvey,
  type Survey,
  type SurveyTally,
} from '@core/survey.ts';
import { Field, Meter, Name, Sheet, TopBar } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import type { Account } from '../lib/account.ts';
import { pqKeys } from '../lib/data.ts';
import { nowSeconds } from '../lib/format.ts';
import { useEvents } from '../lib/hooks.ts';
import { publish, query } from '../lib/net.ts';
import { load, save } from '../lib/storage.ts';

const RSA = { name: 'RSA-PSS', hash: 'SHA-384' };

interface Job {
  survey: Event;
  request: Event;
  pending: { questionId: string; prepared: string; inv: string }[];
  answers: Record<string, string>;
  scheduled?: { event: Event; at: number }[];
}

type Secrets = Record<string, Record<string, string>>;

async function surveyFrom(ev: Event): Promise<Survey | undefined> {
  return parseSurvey(ev, await pqKeys([ev.pubkey]));
}

/** Runs whenever the app is open: issues tokens for the creator's surveys and sends this device's scheduled answers. */
export async function runSurveyJobs(account: Account): Promise<void> {
  const secrets = load<Secrets>('surveySecrets', {});
  for (const [surveyId, keys] of Object.entries(secrets)) {
    const [ev] = await query({ ids: [surveyId] }, 3000);
    const survey = ev && (await surveyFrom(ev));
    if (!survey || survey.closes < nowSeconds()) continue;
    const imported = new Map(await Promise.all(Object.entries(keys).map(async ([q, pkcs8]) =>
      [q, await crypto.subtle.importKey('pkcs8', new Uint8Array(base64.decode(pkcs8)), RSA, true, ['sign'])] as const)));
    const [requests, issues] = await Promise.all([
      query({ kinds: [KIND.tokenRequest], '#e': [surveyId] }, 3000),
      query({ kinds: [KIND.tokenIssue], authors: [account.pubkey], '#e': [surveyId] }, 3000),
    ]);
    const issuedTo = new Set(issues.map((i) => i.tags.find((t) => t[0] === 'p')?.[1] ?? ''));
    for (const req of requests) {
      const issue = await issueTokens(account.nostrKey, survey, imported, req, issuedTo);
      if (issue) await publish(issue).catch(() => undefined);
    }
  }

  const jobs = load<Job[]>('surveyJobs', []);
  const now = nowSeconds();
  for (const job of jobs) {
    if (!job.scheduled) {
      const [issue] = await query({ kinds: [KIND.tokenIssue], '#e': [job.request.id] }, 3000);
      const survey = issue && (await surveyFrom(job.survey));
      if (!issue || !survey) continue;
      const tokens = await finalizeTokens(survey, job.request, job.pending.map((p) => ({
        questionId: p.questionId, prepared: base64.decode(p.prepared), inv: base64.decode(p.inv),
      })), issue);
      const chosen = tokens.filter((t) => job.answers[t.questionId]);
      const times = answerTimes(chosen.length, now, Math.min(survey.closes, now + 6 * 3600));
      job.scheduled = chosen.map((t, i) => ({ event: createAnswer(survey, t, job.answers[t.questionId], times[i]), at: times[i] }));
    }
    for (const s of job.scheduled.filter((x) => x.at <= now)) {
      await publish(s.event).then(() => (s.at = Infinity), () => undefined);
    }
    job.scheduled = job.scheduled.filter((s) => s.at !== Infinity);
  }
  save('surveyJobs', jobs.filter((j) => !j.scheduled || j.scheduled.length));
}

function SurveySheet({ survey, onClose }: { survey: Survey; onClose: () => void }) {
  const { account, toast } = useApp();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    try {
      const { request, pending } = await requestTokens(account.nostrKey, survey);
      await publish(request);
      const job: Job = {
        survey: survey.event, request, answers,
        pending: pending.map((p) => ({ questionId: p.questionId, prepared: base64.encode(p.prepared), inv: base64.encode(p.inv) })),
      };
      save('surveyJobs', [...load<Job[]>('surveyJobs', []), job]);
      toast('Thanks! Your answers go out anonymously once they confirm.');
      onClose();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={survey.title} onClose={onClose}>
      <p><strong><Name pubkey={survey.creator} /></strong> asks: “{survey.purpose}”</p>
      <p className="small muted">Your answers are anonymous: each one is sent separately, at a random time, from a key used once. Only totals can be counted.
        Taking part is visible; your answers are not. Skip any question you like.</p>
      {survey.questions.map((q) => (
        <div key={q.id} className="stack">
          <strong>{q.prompt}</strong>
          <div className="chips">
            {q.choices.map((c) => (
              <button key={c} type="button" className="chip" aria-pressed={answers[q.id] === c}
                onClick={() => setAnswers({ ...answers, [q.id]: answers[q.id] === c ? '' : c })}>{c}</button>
            ))}
          </div>
        </div>
      ))}
      <button type="button" className="btn primary block" disabled={busy || !Object.values(answers).some(Boolean)} onClick={send}>Send anonymously</button>
    </Sheet>
  );
}

export function SurveyPrompts({ follows }: { follows: Set<string> }) {
  const { events } = useEvents(follows.size ? { kinds: [KIND.survey], authors: [...follows].slice(0, 300), since: nowSeconds() - 30 * 86400, limit: 10 } : null);
  const [hidden, setHidden] = useState(() => new Set(load<string[]>('surveysSeen', [])));
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [open, setOpen] = useState<Survey>();
  useEffect(() => {
    const joined = new Set(load<Job[]>('surveyJobs', []).map((j) => j.survey.id));
    Promise.all(events.map(surveyFrom)).then((list) =>
      setSurveys(list.filter((s): s is Survey => !!s && s.closes > nowSeconds() && !joined.has(s.event.id))));
  }, [events]);
  const dismiss = (id: string) => {
    const next = new Set(hidden).add(id);
    setHidden(next);
    save('surveysSeen', [...next]);
  };
  const visible = surveys.filter((s) => !hidden.has(s.event.id)).slice(0, 2);
  return (
    <>
      {visible.map((s) => (
        <div key={s.event.id} className="card" style={{ margin: '12px 16px' }}>
          <p style={{ marginTop: 0 }}><strong>Help <Name pubkey={s.creator} /> find sponsors that fit you</strong></p>
          <p className="small muted">{s.questions.length} quick questions. Anonymous.</p>
          <div className="row">
            <button type="button" className="btn primary small" onClick={() => setOpen(s)}>Take part</button>
            <button type="button" className="btn ghost small" onClick={() => dismiss(s.event.id)}>Not now</button>
          </div>
        </div>
      ))}
      {open && <SurveySheet survey={open} onClose={() => (dismiss(open.event.id), setOpen(undefined))} />}
    </>
  );
}

export function TallyView({ tally }: { tally: SurveyTally }) {
  return (
    <div className="stack">
      <p className="small muted">{tally.participants} {tally.participants === 1 ? 'person has' : 'people have'} taken part.</p>
      {tally.suspect && <p className="small bad">There are more answers than participants. Some answers may not be genuine.</p>}
      {tally.questions.map((q) => (
        <div key={q.id} className="stack" style={{ gap: 6 }}>
          <strong className="small">{q.prompt}</strong>
          {q.counts.map((c) => (
            <div key={c.choice} className="stack" style={{ gap: 2 }}>
              <div className="row between tiny"><span>{c.choice}</span><span className="muted">{q.total ? Math.round((c.count / q.total) * 100) : 0}% · {c.count}</span></div>
              <Meter fraction={q.total ? c.count / q.total : 0} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export async function loadTally(survey: Survey): Promise<SurveyTally> {
  const events = await query({ kinds: [KIND.tokenRequest, KIND.tokenIssue, KIND.answer], '#e': [survey.event.id] }, 4000);
  return tallySurvey(survey, events);
}

function MySurvey({ ev }: { ev: Event }) {
  const [state, setState] = useState<{ survey: Survey; tally: SurveyTally }>();
  useEffect(() => {
    surveyFrom(ev).then(async (survey) => survey && setState({ survey, tally: await loadTally(survey) }));
  }, [ev]);
  if (!state) return <div className="card muted small">Counting answers…</div>;
  const open = state.survey.closes > nowSeconds();
  return (
    <div className="card stack">
      <div className="row between"><h3>{state.survey.title}</h3><span className={`badge${open ? ' good' : ''}`}>{open ? 'Open' : 'Closed'}</span></div>
      <TallyView tally={state.tally} />
    </div>
  );
}

export function SurveyScreen() {
  const { account, navigate, toast } = useApp();
  const { events } = useEvents({ kinds: [KIND.survey], authors: [account.pubkey], limit: 10 });
  const [creating, setCreating] = useState(false);
  const [purpose, setPurpose] = useState('So I can choose sponsors that fit you. Answers are anonymous; only totals are public.');
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const { event, secrets } = await createSurvey(account.nostrKey, account.pq, {
        title: 'Who’s here?', purpose, questions: [STANDARD_QUESTIONS.age, STANDARD_QUESTIONS.region], closes: nowSeconds() + 14 * 86400,
      });
      const exported: Record<string, string> = {};
      for (const [q, key] of secrets) exported[q] = base64.encode(new Uint8Array(await crypto.subtle.exportKey('pkcs8', key)));
      save('surveySecrets', { ...load<Secrets>('surveySecrets', {}), [event.id]: exported });
      await publish(event);
      toast('Survey posted. Your followers will see an invitation.');
      setCreating(false);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar title="Audience survey" back={() => navigate('/create')} />
      <div className="page">
        <p className="muted">Advertisers want to know who your audience is. Instead of tracking anyone, ask: followers answer anonymously, and
          anyone can recount the totals, so sponsors can trust them.</p>
        {creating ? (
          <div className="card stack">
            <Field label="Why you’re asking" hint="Your followers see this in your own words."><textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} /></Field>
            <p className="small">Questions: age range and region (standard wording, so sponsors can compare). Open for 14 days.</p>
            <button type="button" className="btn primary" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Post survey'}</button>
          </div>
        ) : (
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>New survey</button>
        )}
        {events.map((ev) => <MySurvey key={ev.id} ev={ev} />)}
      </div>
    </>
  );
}
