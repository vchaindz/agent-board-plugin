import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format, normalizeRemote, normalizeRepo, overlapText, parseDuration, sessionTitle, standupLine } from '../cli/agb.mjs'

test('normalizeRemote folds ssh and https remotes', () => {
  assert.equal(normalizeRemote('git@github.com:Acme/Web.git'), 'github.com/acme/web')
  assert.equal(normalizeRemote('https://token@github.com/acme/web.git'), 'github.com/acme/web')
  assert.equal(normalizeRemote('ssh://git@gitlab.example.com:2222/acme/web'), 'gitlab.example.com/acme/web')
})

test('parseDuration and format', () => {
  assert.equal(parseDuration('10m'), 600_000)
  assert.throws(() => parseDuration('soon'))
  assert.equal(format({ id: 3, re: 1, channel: 'general', handle: 'a', harness: 'codex', model: 'm', text: 'hi' }), '#3 ↳1 [general] @a (codex/m): hi')
})

test('format lists attachments and overlapText names peer and files', () => {
  const m = { id: 9, channel: 'general', handle: 'a', text: 'see', attachments: [{ id: 7, name: 'shot.png', type: 'image/png', size: 2048 }] }
  assert.equal(format(m), '#9 [general] @a: see\n  [file 7: shot.png, image/png, 2 KB; agb get 7]')
  assert.match(overlapText([{ handle: 'codex-x', files: ['src/a.ts', 'b.ts'] }]), /@codex-x is also changing src\/a\.ts, b\.ts/)
})

test('standupLine marks blockers and leaves out empty fields', () => {
  const line = standupLine({ standup_next: 'write tests', standup_blocked: 'no staging creds', standup_at: Date.now() })
  assert.equal(line, 'next: write tests · BLOCKED: no staging creds (0m ago)')
  assert.equal(standupLine({}), '')
})

test('format marks tasks: open ones say how to claim, claimed ones who holds them', () => {
  const task = { id: 4, channel: 'repo:acme/web', handle: 'lead', text: 'bump the version' }
  assert.equal(format({ ...task, task_state: 'open' }), '#4 [repo:acme/web] [task open: agb claim 4] @lead: bump the version')
  assert.equal(format({ ...task, task_state: 'claimed', holder_handle: 'codex-web-1a2b' }), '#4 [repo:acme/web] [task, held by @codex-web-1a2b] @lead: bump the version')
  assert.equal(format({ ...task, task_state: 'done' }), '#4 [repo:acme/web] [task done] @lead: bump the version')
})

test('sessionTitle takes the name the user gave the session, else the generated one', () => {
  const generated = '{"type":"ai-title","aiTitle":"fix the login form","sessionId":"s"}'
  const given = '{"type":"custom-title","customTitle":"Agent Board fixes","sessionId":"s"}'
  const later = '{"type":"ai-title","aiTitle":"review the board","sessionId":"s"}'
  assert.equal(sessionTitle(['tle":"cut off"}', generated, '{"type":"user","message":{}}'].join('\n')), 'fix the login form')
  assert.equal(sessionTitle([generated, given, later].join('\n')), 'Agent Board fixes')
  assert.equal(sessionTitle(''), undefined)
})

// A board that answers /api/hello as `hello` says, then runs one prompt hook in a new folder.
async function promptAfterMove(hello) {
  const seen = { prompts: [], helloDropped: false }
  const board = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      if (req.url === '/api/enroll') return res.end(JSON.stringify({ token: 't', agent: { handle: 'a', id: 1 } }))
      if (req.url === '/api/hello') {
        res.on('close', () => (seen.helloDropped ||= !res.writableEnded))
        return hello(res)
      }
      seen.prompts.push(JSON.parse(body).prompt)
      res.end(JSON.stringify({ messages: [], online: 0 }))
    })
  })
  await new Promise(resolve => board.listen(0, '127.0.0.1', resolve))
  const home = mkdtempSync(join(tmpdir(), 'agb-cli-'))
  try {
    const child = spawn('node', [new URL('../cli/agb.mjs', import.meta.url).pathname, 'hook', '--harness', 'codex'], {
      env: { ...process.env, AGB_HOME: home, AGB_URL: `http://127.0.0.1:${board.address().port}`, AGB_SECRET: 's' },
    })
    child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: home, prompt: 'typed', redacted: true }))
    await new Promise(resolve => child.on('exit', resolve))
    return seen
  } finally {
    board.closeAllConnections()
    board.close()
    rmSync(home, { recursive: true })
  }
}

test('a hook still reports the prompt when telling the board about a new folder fails', async () => {
  assert.deepEqual((await promptAfterMove(res => res.writeHead(500).end('{}'))).prompts, ['typed'])
})

test('a hook gives up on a slow hello, so with the inbox call it fits the 5 s Codex gives it', async () => {
  const seen = await promptAfterMove(res => setTimeout(() => res.destroyed || res.end('{}'), 2500))
  assert.deepEqual(seen, { prompts: ['typed'], helloDropped: true })
})

test('normalizeRepo reads owner/name as GitHub and a URL or remote like git does', () => {
  assert.equal(normalizeRepo('vchaindz/dbfrog-portal'), 'github.com/vchaindz/dbfrog-portal')
  assert.equal(normalizeRepo('https://github.com/VchainDZ/dbfrog-portal.git'), 'github.com/vchaindz/dbfrog-portal')
  assert.equal(normalizeRepo('git@gitlab.example.com:acme/web.git'), 'gitlab.example.com/acme/web')
  assert.throws(() => normalizeRepo('dbfrog'), /not a repo/)
})
