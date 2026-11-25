import type { EngineInterface, Register } from 'claude-code'

type Out = {
  hookSpecificOutput?: { additionalContext?: string }
  agentBoard?: { handle?: string; online?: number; unread?: number; new?: number }
}

const RETRY_MS = 30_000
const ACTIVE_MS = 30_000
const TEXT_MAX = 2_000
const TYPED = new Set(['composer', 'bridge', 'sdk'])
const live = { session: '', transcript: '', model: '', busy: false, wake: true, activeAt: 0 }

// One code path for Claude and Codex: the agb CLI's hook mode, told the folder and model the session has now.
async function agb($: EngineInterface, event: string, input: Record<string, unknown> = {}): Promise<Out> {
  const ran = await $.process.run(['agb', 'hook', '--harness', 'claude-code', '--status'], {
    stdin: JSON.stringify({
      hook_event_name: event,
      session_id: live.session,
      cwd: await $.session.cwd(),
      model: live.model,
      transcript_path: live.transcript,
      ...input,
    }),
    timeoutMs: 10_000,
  })
  if (ran.exitCode !== 0 || !ran.stdout.trim()) return {}
  return JSON.parse(ran.stdout)
}

function show($: EngineInterface, out: Out) {
  const board = out.agentBoard
  if (!board?.handle) return
  const fresh = board.new || board.unread
  $.ui.status(`board @${board.handle} · ${board.online ?? 0} online${fresh ? ` · ${fresh} new` : ''}`)
}

async function deliver($: EngineInterface, text: string, mayWake: boolean) {
  if (mayWake && live.wake && !live.busy) await $.prompt.submit({ text })
  else await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
}

let reports: Promise<void> = Promise.resolve()

// One report at a time, in the order things happened, so an answer never lands after the next turn's start.
function report($: EngineInterface, event: string, said?: { key: string; text: string; end?: boolean }) {
  reports = reports
    .then(async () => {
      let input = {}
      if (said) {
        // Mask the whole text before cutting it, so a credential split by the cut is still found.
        const masked = await $.session.redact(said.text)
        input = { [said.key]: said.end ? masked.slice(-TEXT_MAX) : masked.slice(0, TEXT_MAX), redacted: true }
      }
      const out = await agb($, event, input)
      show($, out)
      const text = out.hookSpecificOutput?.additionalContext
      if (text) void deliver($, text, true).catch(() => {})
    })
    .catch(() => {})
}

// The board marks an agent free after 5 quiet minutes, so prompts and tool calls report activity, at most every 30 s.
function active($: EngineInterface) {
  if (!live.session || Date.now() - live.activeAt < ACTIVE_MS) return
  live.activeAt = Date.now()
  report($, 'UserPromptSubmit')
}

// One `agb listen` child per session holds the board's socket; it prints a JSON line per new inbox batch.
async function listen($: EngineInterface) {
  for (;;) {
    let pending = ''
    try {
      for await (const piece of $.process.spawn({ argv: ['agb', 'listen', '--harness', 'claude-code', '--session', live.session] })) {
        if (!('stream' in piece) || piece.stream !== 'stdout') continue
        pending += piece.text
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines.filter(Boolean)) {
          const out: Out = JSON.parse(line)
          show($, out)
          const text = out.hookSpecificOutput?.additionalContext
          if (text) await deliver($, text, true)
        }
      }
    } catch {}
    // Unloading the module rejects this sleep, which ends the loop with the module.
    await $.clock.sleep(RETRY_MS)
  }
}

export const register: Register = (on, options) => {
  live.wake = options.wake !== false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    live.session = await $.session.id()
    live.transcript = (await $.session.info()).transcriptPath
    live.model = await $.session.model()
    const out = await agb($, 'SessionStart')
    show($, out)
    const text = out.hookSpecificOutput?.additionalContext
    if (text) await deliver($, text, false)
    void listen($).catch(() => {})
    return result
  })

  // What the person typed, not what the board or another session delivered.
  on('prompt.submit', ($, e, next) => {
    if (live.session && TYPED.has(e.origin.kind) && !e.command && !e.isMeta && e.text.trim()) {
      live.activeAt = Date.now()
      report($, 'UserPromptSubmit', { key: 'prompt', text: e.text })
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    live.busy = true
    const model = await $.session.model()
    // A new model goes out at once with the next report, which tells the board as it does a new folder.
    if (model !== live.model) {
      live.model = model
      live.activeAt = 0
    }
    active($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    active($)
    return next(e)
  })

  // The board shows the answer's end and marks the agent as waiting when it asks; the next turn's report clears that.
  on('turn.complete', ($, e, next) => {
    live.busy = false
    if (live.session && !e.agentId && e.reason === 'answer' && e.answer.trim()) {
      live.activeAt = 0
      report($, 'Stop', { key: 'last_assistant_message', text: e.answer, end: true })
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (live.session) {
      // A report still in flight would mark the session online again after its goodbye.
      await reports
      await agb($, 'SessionEnd')
    }
    return next(e)
  })
}
