/**
 * Follow-up thread — Host half.
 *
 * Answers an inline "追问" (follow-up question) about one earlier answer.
 *
 * The answer is produced here, in the Host, by calling the model directly over
 * the conversation context cut at the answer's seq. Nothing is created in the
 * Session list: no child Session, no fork, so the left workspace never gains a
 * conversation for a follow-up.
 *
 * A thread is a conversation: `history` carries the turns already exchanged
 * under this answer, so the user can keep talking in the same thread instead of
 * starting a new one for every question.
 *
 * Route: POST /api/followup-thread/ask
 *   request  { sessionId: string, atSeq?: number, question: string,
 *              history?: Array<{ role: 'user' | 'assistant', text: string }> }
 *   response { ok: true, value: { answer: string, provider?: string, model?: string } }
 *          | { ok: false, error: { code: string, message: string } }
 */

const ROUTE = '/api/followup-thread/ask'
const MAX_CONTEXT_CHARS = 80000
const TOOL_ARGS_CHARS = 400
const TOOL_RESULT_CHARS = 1500
const ANSWER_TIMEOUT_MS = 180000
const MAX_HISTORY_TURNS = 40
const HISTORY_TURN_CHARS = 4000

const INSTRUCTIONS = [
  '下面是用户与你此前的一段对话记录（含当时调用了哪些工具、拿到了什么结果），记录截止到其中最后一条回答。用户现在针对那条回答提出了一个追问，请直接回答这个追问。',
  '',
  '背景：这段对话发生在 DeepSeek Harness（简称 DSH）里 —— 一个可编程的 AI 编码代理，有桌面端和网页端，可以读写文件、执行命令、使用工具。你此刻正在其中作为助手作答。',
  '',
  '回答要求：',
  '1. 直接作答，把这段记录和你的知识结合起来：记录提供语境和已经发生的事实，你的知识用来解释、判断和补充。',
  '2. 承接这段对话已有的判断：记录里已经定下的方案、改过的文件、得出的结论，要与之一致；不要重复已经解决的问题，也不要说与记录相反的话。',
  '3. 记录里的工具调用与工具结果是真实经过（读过哪些文件、跑过哪些命令、得到什么输出），可以据此推断当前的代码和配置状态。',
  '4. 不要用「我无法读取文件」「我不能访问」这类话开头或结尾；记录之后发生的变化如果确实影响答案，用一句话说明，然后照常给出判断。',
  '5. 聚焦在追问本身，简明作答，不要复述整段历史。',
  '',
  '追问：',
].join('\n')

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status === undefined ? 200 : status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function failure(code, message) {
  return jsonResponse({ ok: false, error: { code, message } })
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Cut a long string to `limit` characters, marking the cut. */
function clip(text, limit) {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/\r\n/g, '\n').trim()
  if (flat.length <= limit) return flat
  return flat.slice(0, limit) + '\n…（已截断）'
}

function textOfMessage(message) {
  if (!isRecord(message) || !Array.isArray(message.content)) return ''
  return message.content
    .map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
    .trim()
}

function hasImageBlock(message) {
  if (!isRecord(message) || !Array.isArray(message.content)) return false
  return message.content.some((block) => isRecord(block) && block.type === 'image')
}

/** Events may arrive bare or wrapped as `{ type: 'event', event: {...} }`. */
function unwrapEvent(record) {
  if (!isRecord(record)) return undefined
  if (isRecord(record.event) && typeof record.event.type === 'string') return record.event
  if (typeof record.type === 'string') return record
  return undefined
}

/**
 * Rebuild the conversation the answer belongs to, up to (and including) `atSeq`.
 *
 * A coding session is mostly tool activity, so the replay keeps it: user text,
 * assistant text, `[调用 <tool>] <arguments>` for every tool call and
 * `[工具结果 <tool>] <text>` for every tool result. Reasoning blocks are left
 * out (they are not part of what the user saw). Tool payloads are clipped so a
 * handful of huge file dumps cannot crowd out the dialogue.
 *
 * The budget is spent from the end backwards, so a long conversation still
 * keeps the turns closest to the answer being asked about.
 */
function deriveMessages(events, atSeq, route) {
  const cut = typeof atSeq === 'number' && Number.isFinite(atSeq) ? atSeq : Infinity
  const names = new Map()
  const entries = []

  const push = (role, text) => {
    const value = typeof text === 'string' ? text.trim() : ''
    if (value.length === 0) return
    const last = entries[entries.length - 1]
    if (last !== undefined && last.role === role) {
      last.text = last.text + '\n\n' + value
      return
    }
    entries.push({ role, text: value })
  }

  for (const record of events) {
    const event = unwrapEvent(record)
    if (event === undefined) continue
    if (typeof event.seq === 'number' && event.seq > cut) continue
    const data = event.data
    if (!isRecord(data)) continue

    if (event.type === 'user/message') {
      if (!isRecord(data.source) || data.source.kind !== 'user') continue
      const text = textOfMessage(data)
      push('user', text.length > 0 ? text : (hasImageBlock(data) ? '[用户发来一张图片]' : ''))
      continue
    }

    if (event.type === 'assistant/message') {
      if (!isRecord(data.message)) continue
      push('assistant', textOfMessage(data.message))
      continue
    }

    if (event.type === 'tool/call') {
      const name = typeof data.name === 'string' ? data.name : 'tool'
      if (typeof data.callId === 'string') names.set(data.callId, name)
      const args = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments || {})
      push('assistant', '[调用 ' + name + '] ' + clip(args, TOOL_ARGS_CHARS))
      continue
    }

    if (event.type === 'tool/result') {
      if (!isRecord(data.message)) continue
      const callId = typeof data.message.toolCallId === 'string'
        ? data.message.toolCallId
        : (isRecord(data.message.source) && typeof data.message.source.callId === 'string' ? data.message.source.callId : '')
      const label = names.get(callId) || 'tool'
      const body = textOfMessage(data.message)
      push('user', '[工具结果 ' + label + '] ' + clip(body, TOOL_RESULT_CHARS))
      continue
    }
  }

  const kept = []
  let chars = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (kept.length > 0 && chars + entry.text.length > MAX_CONTEXT_CHARS) break
    chars += entry.text.length
    kept.push(entry)
  }
  kept.reverse()

  // A conversation must open on a user turn for the adapters to accept it.
  while (kept.length > 0 && kept[0].role !== 'user') kept.shift()

  // Every replayed turn carries the identity and source a durable Message needs;
  // without `source` the LLM runtime dereferences it while filtering replay state.
  const provider = route && typeof route.provider === 'string' ? route.provider : 'unknown'
  const model = route && typeof route.model === 'string' ? route.model : 'unknown'
  return kept.map((entry, index) => ({
    id: 'followup-' + index,
    role: entry.role,
    content: [{ type: 'text', text: entry.text }],
    source: entry.role === 'assistant' ? { kind: 'model', provider, model } : { kind: 'user' },
  }))
}

/**
 * The thread's own earlier turns, oldest first.
 *
 * A follow-up thread is a conversation, not one question: the turns already
 * exchanged under this answer ride on top of the replayed session, so the model
 * sees "what was discussed here" and can be asked again and again. Adjacent
 * turns with the same role are merged because the adapters expect an
 * alternating conversation, and the thread must open with a user turn.
 */
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return []
  const turns = []
  for (const item of history.slice(-MAX_HISTORY_TURNS)) {
    if (!isRecord(item)) continue
    const role = item.role === 'assistant' ? 'assistant' : (item.role === 'user' ? 'user' : null)
    if (role === null) continue
    const text = clip(typeof item.text === 'string' ? item.text : '', HISTORY_TURN_CHARS)
    if (text.length === 0) continue
    const last = turns[turns.length - 1]
    if (last !== undefined && last.role === role) {
      last.text = clip(last.text + '\n\n' + text, HISTORY_TURN_CHARS)
      continue
    }
    turns.push({ role, text })
  }
  while (turns.length > 0 && turns[0].role !== 'user') turns.shift()
  return turns
}

/** Count the event types, to explain an empty replay in the UI. */
function typeHistogram(events, limit) {
  const counts = new Map()
  for (const record of events) {
    const event = unwrapEvent(record)
    if (event === undefined) continue
    counts.set(event.type, (counts.get(event.type) || 0) + 1)
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([type, count]) => ({ type, count }))
}

/**
 * Event access differs between the Agent facade and a plain Session, so try
 * each reader in order and report which one worked.
 */
async function readEvents(agent) {
  const session = agent && agent.session
  const attempts = []
  if (session) {
    if (typeof session.snapshotEvents === 'function') attempts.push(['session.snapshotEvents', () => session.snapshotEvents()])
    if (Array.isArray(session.events)) attempts.push(['session.events[]', () => session.events])
    if (typeof session.events === 'function') attempts.push(['session.events()', () => session.events()])
    if (typeof session.snapshot === 'function') attempts.push(['session.snapshot()', () => session.snapshot()])
    if (isRecord(session.history) && Array.isArray(session.history.events)) attempts.push(['session.history.events', () => session.history.events])
  }
  if (agent && typeof agent.snapshotEvents === 'function') attempts.push(['agent.snapshotEvents', () => agent.snapshotEvents()])

  const tried = []
  for (const [label, read] of attempts) {
    try {
      const value = await read()
      const list = Array.isArray(value)
        ? value
        : (isRecord(value) && Array.isArray(value.events) ? value.events
          : (isRecord(value) && Array.isArray(value.records) ? value.records : null))
      tried.push(label + '=' + (list === null ? 'not-a-list' : list.length))
      if (list !== null && list.length > 0) return { events: list, source: label, tried }
    } catch (error) {
      tried.push(label + '!=' + (error instanceof Error ? error.message : String(error)))
    }
  }
  return { events: [], source: 'none', tried }
}

/** The route the Session itself last ran on, so the answer matches its style. */
function resolveRoute(agent, events) {
  try {
    const current = agent && agent.model && typeof agent.model.current === 'function' ? agent.model.current() : undefined
    if (current && typeof current.provider === 'string' && typeof current.model === 'string') {
      return { provider: current.provider, model: current.model, reasoningEffort: current.reasoningEffort }
    }
  } catch (error) {
    /* fall through to the log */
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!isRecord(event)) continue
    if (event.type === 'model/selection' && isRecord(event.data)) {
      const data = event.data
      const route = data.selection && isRecord(data.selection) ? data.selection : data
      if (typeof route.provider === 'string' && typeof route.model === 'string') {
        return { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort }
      }
    }
    if (event.type === 'request/header' && isRecord(event.data) && isRecord(event.data.header)) {
      const header = event.data.header
      if (typeof header.provider === 'string' && typeof header.model === 'string') {
        return { provider: header.provider, model: header.model }
      }
    }
  }
  return undefined
}

/** Concatenate one model stream into its visible answer text. */
async function collectAnswer(llm, request) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ANSWER_TIMEOUT_MS)
  let text = ''
  const kinds = new Map()
  const notes = []
  try {
    for await (const chunk of llm.stream({ ...request, signal: controller.signal })) {
      if (!isRecord(chunk)) {
        kinds.set(typeof chunk, (kinds.get(typeof chunk) || 0) + 1)
        continue
      }
      const kind = typeof chunk.type === 'string' ? chunk.type : 'untyped'
      kinds.set(kind, (kinds.get(kind) || 0) + 1)
      if (kind === 'text-delta') {
        const piece = typeof chunk.text === 'string' ? chunk.text : (typeof chunk.delta === 'string' ? chunk.delta : '')
        text += piece
      }
      if ((kind === 'error' || kind === 'stream-error' || kind === 'finish') && notes.length < 4) {
        notes.push(JSON.stringify(chunk).slice(0, 240))
      }
    }
  } finally {
    clearTimeout(timer)
  }
  return {
    text: text.trim(),
    kinds: [...kinds.entries()].map(([type, count]) => ({ type, count })),
    notes,
  }
}

export const name = 'followup-thread'

/** Exported for offline checks against a real session log. */
export { deriveMessages }

export function apply(ctx) {
  ctx.inject(['connection'], (scope) => {
    const connection = scope.connection
    if (connection === undefined) {
      ctx.logger.warn('[followup-thread] connection service is unavailable; the ask route is not registered')
      return
    }
    const logger = ctx.logger
    // Looked up lazily: these services may attach after this plugin does.
    const agentsOf = () => scope.get('agents')
    const llmOf = () => scope.get('llm')

    const ask = async (payload) => {
      if (!isRecord(payload)) return failure('followup-thread/bad-request', 'invalid payload')
      const sessionId = payload.sessionId
      const question = typeof payload.question === 'string' ? payload.question.trim() : ''
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return failure('followup-thread/bad-request', 'sessionId must be a non-empty string')
      }
      if (question.length === 0) return failure('followup-thread/bad-request', 'question must be a non-empty string')

      const agents = agentsOf()
      if (agents === undefined) return failure('followup-thread/agents-unavailable', 'agent registry is unavailable')
      const agent = agents.get(sessionId)
      if (agent === undefined) {
        return failure('followup-thread/session-not-attached', 'session ' + sessionId + ' is not attached')
      }

      const session = agent.session
      const read = await readEvents(agent)
      const events = read.events
      const route = resolveRoute(agent, events)
      if (route === undefined) {
        return failure('followup-thread/no-model', 'this session has no recorded model route')
      }

      const messages = deriveMessages(events, payload.atSeq, route)
      if (messages.length === 0) {
        return jsonResponse({
          ok: false,
          error: {
            code: 'followup-thread/no-context',
            message: '这条会话里没有可用的对话记录（来源 ' + read.source + '，事件 ' + events.length + ' 条）',
          },
          diag: {
            source: read.source,
            tried: read.tried,
            eventCount: events.length,
            types: typeHistogram(events, 8),
            atSeq: typeof payload.atSeq === 'number' ? payload.atSeq : null,
            sessionType: session === null ? 'null' : typeof session,
          },
        })
      }
      const llm = llmOf()
      if (llm === undefined || typeof llm.stream !== 'function') {
        return failure('followup-thread/llm-unavailable', 'llm service is unavailable')
      }

      try {
        const history = sanitizeHistory(payload.history)
        const historyMessages = history.map((turn, index) => ({
          id: 'followup-history-' + index,
          role: turn.role,
          content: [{ type: 'text', text: turn.text }],
          source: turn.role === 'assistant'
            ? { kind: 'model', provider: route.provider, model: route.model }
            : { kind: 'user' },
        }))
        // The instructions set up the thread once; later turns continue it and
        // only carry the question itself.
        const questionText = history.length === 0 ? INSTRUCTIONS + question : question
        const result = await collectAnswer(llm, {
          provider: route.provider,
          model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
          messages: [...messages, ...historyMessages, {
            id: 'followup-question',
            role: 'user',
            content: [{ type: 'text', text: questionText }],
            source: { kind: 'user' },
          }],
        })
        if (result.text.length === 0) {
          return jsonResponse({
            ok: false,
            error: { code: 'followup-thread/empty-answer', message: '这次没有拿到模型输出（' + result.kinds.map((item) => item.type + '×' + item.count).join('，') + '）' },
            diag: { kinds: result.kinds, notes: result.notes, provider: route.provider, model: route.model, messages: messages.length, route: route.reasoningEffort || null },
          })
        }
        return jsonResponse({
          ok: true,
          value: { answer: result.text, provider: route.provider, model: route.model, messages: messages.length, turns: history.length, source: read.source },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('[followup-thread] ask failed: ' + message)
        return jsonResponse({
          ok: false,
          error: { code: 'followup-thread/ask-failed', message },
          diag: { provider: route.provider, model: route.model, messages: messages.length, route: route.reasoningEffort || null },
        })
      }
    }

    const handler = async (request) => {
      const type = request.headers.get('content-type')
      if (!type || type.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        return failure('followup-thread/bad-request', 'content type must be application/json')
      }
      let payload
      try {
        payload = await request.json()
      } catch (error) {
        return failure('followup-thread/bad-request', 'body is not JSON')
      }
      return ask(payload)
    }

    try {
      scope.effect(() => connection.fetch.register({
        path: ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: handler,
      }), 'followup-thread ask route')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('[followup-thread] route registration failed for ' + ROUTE + ': ' + message)
    }
  })
}
