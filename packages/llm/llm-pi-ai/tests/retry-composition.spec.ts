/** Codex overload recovery through the real Loader, adapter, loop, and JSONL writer. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { closeMockServers, mockServer } from './mock-server.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await closeMockServers()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

it('retries a Codex overload once and persists the SERVER failure and successful turn', { timeout: 60_000 }, async () => {
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')
  vi.stubEnv('PI_RETRY_COMPOSITION_KEY', `e30.${payload}.fixture`)
  const item = { type: 'message', id: 'msg_recovered', role: 'assistant', content: [{ type: 'output_text', text: 'recovered', annotations: [] }] }
  const server = await mockServer([
    { events: [JSON.stringify({ type: 'error', message: 'Our servers are currently overloaded. Please try again later.' })] },
    { events: [
      JSON.stringify({ type: 'response.created', response: { id: 'resp_recovered' } }),
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }),
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_recovered', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } }),
    ] },
  ])
  root = await mkdtemp(join(tmpdir(), 'dsh-pi-retry-composition-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'sessions'))}`,
    '    compression: none',
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      openai-codex:',
    '        apiKeyEnv: PI_RETRY_COMPOSITION_KEY',
    `        baseURL: ${server.url}`,
    '        transport: sse',
    '        retryPolicy:',
    '          mode: normal',
    '          maxRetries: 1',
    '          backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }',
    "- name: '@deepseek-ai/dsh-llm-retry'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config: { agents: [] }',
    '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlPersistence],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
    ['@deepseek-ai/dsh-llm-retry', Retry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])

  const handle = await ctx.agents.create({
    sessionId: SessionId('codex-overload-retry'),
    agentOptions: { provider: 'openai-codex', model: 'gpt-5.5' },
  })
  const { agent } = handle
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(server.requests, JSON.stringify(agent.session.snapshotEvents())).toHaveLength(2)
  expect(server.requests[1]).toEqual(server.requests[0])
  expect(agent.session.deriveMessages().at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'recovered' }] })
  const events = [...agent.session.snapshotEvents()]
  const retries = events.filter(event => event.type === 'llm/retry')
  expect(retries).toHaveLength(1)
  expect(retries[0]?.data).toMatchObject({
    turn: 1, step: 1, provider: 'openai-codex', mode: 'normal', retry: 1, delayMs: 1,
    failure: { message: 'Codex error: Our servers are currently overloaded. Please try again later.', code: 'SERVER' },
  })
  expect(events.filter(event => event.type === 'step/start')).toHaveLength(1)
  expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason)).toEqual([{ kind: 'completed' }])
  await handle.dispose()
  const reader = await ctx.sessionPersistence.open(agent.session.id, 'read')
  try {
    const persisted = await reader.read()
    expect(persisted.events).toEqual(events)
    expect(persisted.events.filter(event => event.type === 'llm/retry').map(event => ({
      ...event.data, retryId: '<retry-id>',
    }))).toMatchSnapshot()
  } finally {
    await reader.close()
  }
})
