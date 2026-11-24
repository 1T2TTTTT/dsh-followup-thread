/**
 * Follow-up thread — Client half.
 *
 * Adds an inline "追问" thread under every completed answer: the question and
 * its answer render together, at the place the question is about, instead of
 * as a detached turn at the bottom of the conversation. A thread is a small
 * conversation of its own — after the first answer you can keep talking in it,
 * and the whole thread keeps its own history.
 *
 * Answers come from this plugin's own Host route (./api/followup-thread/ask),
 * which replays the conversation context up to this answer, appends the turns
 * this thread has already exchanged, and asks the model directly. No child
 * Session is created, so nothing appears in the left workspace. Threads live in
 * localStorage, per Session.
 */

window.__ModuleLoader__.load({
  id: 'dsh-followup-thread',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STORAGE_PREFIX = 'dsh.followup-thread.v1:'
    const VIEW_PREFIX = 'dsh.followup-thread.v1:view:'
    const ASK_PATH = './api/followup-thread/ask'

    /** Every mounted card re-reads storage when a thread is written. */
    const subscribers = new Set()

    const CSS = `
.fu-root { display: flex; flex-direction: column; gap: 8px; margin: 10px 0 2px; }
.fu-bar { display: flex; align-items: center; gap: 10px; }
.fu-toggle { display: inline-flex; align-items: center; gap: 5px; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, #6b7280); font: inherit; font-size: 12.5px; line-height: 20px; padding: 2px 6px; cursor: pointer; border-radius: var(--dsw-radius-sm, 6px); }
.fu-toggle:hover { color: var(--dsw-alias-label-primary, #111827); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.fu-trigger { align-self: flex-start; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, #6b7280); font: inherit; font-size: 12.5px; line-height: 20px; padding: 2px 6px 2px 0; cursor: pointer; border-radius: var(--dsw-radius-sm, 6px); }
.fu-trigger:hover { color: var(--dsw-alias-label-primary, #111827); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.fu-list { display: flex; flex-direction: column; gap: 6px; }
.fu-item { display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l4, #e5e7eb); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.02)); padding: 6px 10px; cursor: pointer; text-align: left; font: inherit; color: var(--dsw-alias-label-primary, #111827); }
.fu-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.fu-item.fu-current { border-color: var(--dsw-alias-state-business-primary, #4f46e5); }
.fu-item-caret { flex: none; width: 12px; color: var(--dsw-alias-label-secondary, #6b7280); font-size: 11px; }
.fu-item-q { flex: 1 1 auto; min-width: 0; font-size: 13px; line-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fu-item-state { flex: none; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary, #6b7280); }
.fu-thread { border: 0.5px solid var(--dsw-alias-border-l4, #e5e7eb); border-left: 2px solid var(--dsw-alias-state-business-primary, #4f46e5); border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.02)); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.fu-head { display: flex; align-items: center; gap: 8px; }
.fu-badge { flex: none; font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 999px; color: var(--dsw-alias-label-secondary, #6b7280); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }
.fu-q { color: var(--dsw-alias-label-primary, #111827); font-size: 13.5px; line-height: 21px; white-space: pre-wrap; word-break: break-word; }
.fu-a { color: var(--dsw-alias-label-primary, #111827); font-size: 13.5px; line-height: 22px; white-space: pre-wrap; word-break: break-word; }
.fu-a.fu-pending { color: var(--dsw-alias-label-secondary, #6b7280); }
.fu-turn { display: flex; flex-direction: column; gap: 3px; }
.fu-turn + .fu-turn { border-top: 0.5px dashed var(--dsw-alias-border-l4, #e5e7eb); padding-top: 8px; }
.fu-turn-user .fu-q { font-weight: 500; }
.fu-meta { display: flex; align-items: center; gap: 10px; }
.fu-link { border: 0; background: transparent; padding: 0; cursor: pointer; color: var(--dsw-alias-state-business-primary, #4f46e5); font: inherit; font-size: 12px; }
.fu-error { color: var(--dsw-alias-state-error-primary, #b91c1c); font-size: 12px; line-height: 18px; }
.fu-compose { display: flex; flex-direction: column; gap: 8px; border: 0.5px solid var(--dsw-alias-border-l4, #e5e7eb); border-radius: var(--dsw-radius-lg, 10px); padding: 10px 12px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.02)); }
.fu-continue { display: flex; flex-direction: column; gap: 6px; border-top: 0.5px dashed var(--dsw-alias-border-l4, #e5e7eb); padding-top: 8px; }
.fu-input { box-sizing: border-box; width: 100%; min-height: 62px; max-height: 220px; resize: vertical; border: 0.5px solid var(--dsw-alias-border-l4, #e5e7eb); border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-primary, #111827); font: inherit; font-size: 13.5px; line-height: 21px; padding: 8px 10px; }
.fu-input.fu-input-sm { min-height: 40px; }
.fu-input:focus { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4f46e5)); outline-offset: 1px; }
.fu-row { display: flex; align-items: center; gap: 8px; }
.fu-btn { height: 28px; padding: 0 12px; border-radius: var(--dsw-radius-sm, 6px); border: 0.5px solid var(--dsw-alias-border-l4, #e5e7eb); background: transparent; color: var(--dsw-alias-label-primary, #111827); font: inherit; font-size: 13px; cursor: pointer; }
.fu-btn.fu-primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, #4f46e5); color: var(--dsw-alias-label-primary-foreground, #fff); }
.fu-btn:disabled { opacity: 0.5; cursor: default; }
.fu-hint { color: var(--dsw-alias-label-secondary, #6b7280); font-size: 11.5px; }
`

    /** Turns exchanged before a thread object carried them are lifted in place. */
    function migrateThread(thread) {
      if (!thread || typeof thread !== 'object') return null
      if (Array.isArray(thread.turns)) return thread
      const turns = []
      if (typeof thread.question === 'string' && thread.question.trim()) {
        turns.push({ role: 'user', text: thread.question, status: 'done' })
      }
      if (typeof thread.answer === 'string' && thread.answer.trim()) {
        turns.push({ role: 'assistant', text: thread.answer, status: 'done' })
      }
      return Object.assign({}, thread, { turns })
    }

    function readThreads(sessionId) {
      try {
        const raw = window.localStorage.getItem(STORAGE_PREFIX + sessionId)
        const parsed = raw ? JSON.parse(raw) : []
        if (!Array.isArray(parsed)) return []
        return parsed.map(migrateThread).filter((thread) => thread !== null)
      } catch (error) {
        return []
      }
    }

    function writeThreads(sessionId, threads) {
      try {
        window.localStorage.setItem(STORAGE_PREFIX + sessionId, JSON.stringify(threads))
      } catch (error) {
        /* a full or blocked storage must not break the card */
      }
      subscribers.forEach((notify) => {
        try {
          notify()
        } catch (error) {
          /* ignore a broken subscriber */
        }
      })
    }

    function patchThread(sessionId, threadId, values) {
      const next = readThreads(sessionId).map((thread) => (
        thread.id === threadId ? Object.assign({}, thread, values) : thread
      ))
      writeThreads(sessionId, next)
      return next
    }

    function findThread(sessionId, threadId) {
      return readThreads(sessionId).find((thread) => thread.id === threadId) || null
    }

    function readView(sessionId) {
      try {
        const raw = window.localStorage.getItem(VIEW_PREFIX + sessionId)
        const parsed = raw ? JSON.parse(raw) : {}
        if (!parsed || typeof parsed !== 'object') return { open: {}, active: {} }
        return {
          open: parsed.open && typeof parsed.open === 'object' ? parsed.open : {},
          active: parsed.active && typeof parsed.active === 'object' ? parsed.active : {},
        }
      } catch (error) {
        return { open: {}, active: {} }
      }
    }

    function writeView(sessionId, mutate) {
      try {
        const view = readView(sessionId)
        mutate(view)
        window.localStorage.setItem(VIEW_PREFIX + sessionId, JSON.stringify(view))
      } catch (error) {
        /* storage is optional here */
      }
    }

    function newId(prefix) {
      let random = ''
      try {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
          random = window.crypto.randomUUID()
        }
      } catch (error) {
        random = ''
      }
      if (!random) random = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 10)
      return prefix + random
    }

    /** The list label of a thread: the first thing that was asked in it. */
    function titleOf(thread) {
      const turns = Array.isArray(thread.turns) ? thread.turns : []
      const first = turns.find((turn) => turn.role === 'user' && turn.text)
      if (first) return first.text
      return typeof thread.question === 'string' ? thread.question : ''
    }

    /** Completed turns, in the shape the Host replays them. */
    function historyOf(thread) {
      const turns = Array.isArray(thread.turns) ? thread.turns : []
      return turns
        .filter((turn) => (turn.role === 'user' || turn.role === 'assistant')
          && typeof turn.text === 'string' && turn.text.trim()
          && turn.status !== 'running' && turn.status !== 'error')
        .map((turn) => ({ role: turn.role, text: turn.text }))
    }

    /**
     * Ask this plugin's Host route for an answer to `question` about the state
     * of the conversation as of `seq`, on top of `history` — the turns this
     * thread already exchanged. No Session is created for it.
     */
    async function askHost(sessionId, seq, question, history) {
      const body = { sessionId, question }
      if (typeof seq === 'number') body.atSeq = seq
      if (Array.isArray(history) && history.length > 0) body.history = history
      let response
      try {
        response = await window.fetch(ASK_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (error) {
        throw new Error('追问服务不可用（插件宿主没有响应）')
      }
      if (!response.ok) throw new Error('追问服务返回 HTTP ' + response.status)
      let result
      try {
        result = await response.json()
      } catch (error) {
        throw new Error('追问服务返回了无法解析的内容')
      }
      if (!result || typeof result !== 'object') throw new Error('追问服务返回了空响应')
      if (result.ok === false) {
        const error = result.error
        const failure = new Error(error && error.message ? error.message : '追问失败')
        if (result.diag && typeof result.diag === 'object') failure.diag = result.diag
        throw failure
      }
      const value = result.value || {}
      if (typeof value.answer !== 'string' || !value.answer.trim()) throw new Error('模型没有返回内容')
      return value.answer
    }

    /** Compact one-line description of a Host diagnostic payload. */
    function describeDiag(diag) {
      if (!diag || typeof diag !== 'object') return ''
      const parts = []
      if (diag.source) parts.push('来源 ' + String(diag.source))
      if (diag.eventCount !== undefined) parts.push('事件 ' + String(diag.eventCount))
      if (Array.isArray(diag.types) && diag.types.length) {
        parts.push(diag.types.map((item) => String(item.type) + '×' + String(item.count)).join('，'))
      }
      if (Array.isArray(diag.kinds) && diag.kinds.length) {
        parts.push('分片 ' + diag.kinds.map((item) => String(item.type) + '×' + String(item.count)).join('，'))
      }
      if (diag.provider || diag.model) parts.push([diag.provider, diag.model].filter(Boolean).join('/'))
      if (diag.messages !== undefined) parts.push('上下文 ' + String(diag.messages) + ' 条')
      if (Array.isArray(diag.notes) && diag.notes.length) parts.push('错误 ' + diag.notes.join(' | '))
      if (Array.isArray(diag.tried) && diag.tried.length) parts.push('尝试 ' + diag.tried.join('；'))
      return parts.join('｜')
    }

    /**
     * Append one question to a thread and wait for its answer.
     *
     * The thread keeps its own transcript: the question and a pending answer are
     * written before the Host is called, so a reload mid-answer still shows what
     * was asked. `settle` releases the busy flag of the composer.
     */
    async function askInThread(sessionId, seq, threadId, question, settle) {
      const thread = findThread(sessionId, threadId)
      if (thread === null) {
        if (settle) settle()
        return
      }
      const history = historyOf(thread)
      patchThread(sessionId, threadId, {
        turns: (thread.turns || []).concat([
          { role: 'user', text: question, status: 'done' },
          { role: 'assistant', text: '', status: 'running' },
        ]),
        status: 'running',
        error: null,
        diag: null,
      })
      try {
        const answer = await askHost(sessionId, seq, question, history)
        const current = findThread(sessionId, threadId)
        const turns = (current && current.turns ? current.turns : []).slice()
        if (turns.length > 0) turns[turns.length - 1] = { role: 'assistant', text: answer, status: 'done' }
        patchThread(sessionId, threadId, { turns, status: 'done', error: null, diag: null })
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        const diag = error && error.diag ? error.diag : null
        const current = findThread(sessionId, threadId)
        const turns = (current && current.turns ? current.turns : []).slice()
        if (turns.length > 0) turns[turns.length - 1] = { role: 'assistant', text: '', status: 'error' }
        patchThread(sessionId, threadId, { turns, status: 'error', error: message, diag })
      } finally {
        if (settle) settle()
      }
    }

    function createComponent(ctx) {
      function createThread(sessionId, seq, question, settle, activate) {
        const thread = {
          id: newId('followup-thread-'),
          seq,
          turns: [],
          status: 'running',
          error: null,
          createdAt: Date.now(),
        }
        writeThreads(sessionId, readThreads(sessionId).concat([thread]))
        if (typeof activate === 'function') activate(thread.id)
        askInThread(sessionId, seq, thread.id, question, settle)
        return thread
      }

      /**
       * Ask the last question of a thread again: everything from that question
       * onwards is dropped first, so retrying never stacks duplicate turns.
       */
      function retryThread(sessionId, seq, thread, settle) {
        const turns = Array.isArray(thread.turns) ? thread.turns.slice() : []
        let start = turns.length - 1
        while (start >= 0 && turns[start].role !== 'user') start -= 1
        if (start < 0) {
          if (settle) settle()
          return
        }
        const question = turns[start].text
        const kept = turns.slice(0, start)
        patchThread(sessionId, thread.id, { turns: kept, status: 'running', error: null, diag: null })
        askInThread(sessionId, seq, thread.id, question, settle)
      }

      function FollowupThreads(props) {
        /** Owner props may arrive flat or under `ownerProps`; accept both. */
        const owner = (props && props.ownerProps) || props || {}
        const turn = owner.turn || {}
        const sessionId = (props && props.sessionId) || owner.sessionId || turn.sessionId
        const seqValue = props && props.seq !== undefined
          ? props.seq
          : (owner.seq !== undefined ? owner.seq : (turn.seq !== undefined ? turn.seq : turn.endSeq))
        const seq = typeof seqValue === 'number' ? seqValue : undefined
        const [threads, setThreads] = React.useState(() => (sessionId ? readThreads(sessionId) : []))
        const [draft, setDraft] = React.useState('')
        const [reply, setReply] = React.useState('')
        const [composing, setComposing] = React.useState(false)
        const [busy, setBusy] = React.useState(false)
        const [panelOpen, setPanelOpen] = React.useState(() => {
          if (!sessionId || typeof seq !== 'number') return false
          return readView(sessionId).open[String(seq)] === true
        })
        const [activeId, setActiveId] = React.useState(() => {
          if (!sessionId || typeof seq !== 'number') return null
          return readView(sessionId).active[String(seq)] || null
        })

        React.useEffect(() => {
          if (!sessionId) return undefined
          const notify = () => setThreads(readThreads(sessionId))
          notify()
          subscribers.add(notify)
          return () => { subscribers.delete(notify) }
        }, [sessionId])

        React.useEffect(() => {
          if (!activeId) return
          if (!threads.some((thread) => thread.id === activeId)) setActiveId(null)
        }, [threads, activeId])

        const rememberView = (nextOpen, nextActive) => {
          if (!sessionId || typeof seq !== 'number') return
          writeView(sessionId, (view) => {
            view.open[String(seq)] = nextOpen
            if (nextActive === null) delete view.active[String(seq)]
            else if (nextActive) view.active[String(seq)] = nextActive
          })
        }

        const openPanel = () => {
          setPanelOpen(true)
          rememberView(true)
        }

        const closePanel = () => {
          setPanelOpen(false)
          rememberView(false)
        }

        const pick = (thread) => {
          const next = activeId === thread.id ? null : thread.id
          setActiveId(next)
          setPanelOpen(true)
          rememberView(true, next)
        }

        const remove = (threadId) => {
          writeThreads(sessionId, readThreads(sessionId).filter((thread) => thread.id !== threadId))
        }

        const activate = (id) => {
          setActiveId(id)
          setPanelOpen(true)
          rememberView(true, id)
        }

        const submitNew = () => {
          const text = String(draft || '').trim()
          if (!text) return
          setDraft('')
          setComposing(false)
          setBusy(true)
          createThread(sessionId, seq, text, () => setBusy(false), activate)
        }

        const submitReply = (thread) => {
          const text = String(reply || '').trim()
          if (!text) return
          setReply('')
          setBusy(true)
          askInThread(sessionId, seq, thread.id, text, () => setBusy(false))
        }

        const retry = (thread) => {
          setBusy(true)
          setActiveId(thread.id)
          rememberView(true, thread.id)
          retryThread(sessionId, seq, thread, () => setBusy(false))
        }

        if (!sessionId || typeof seq !== 'number') return null
        const mine = threads.filter((thread) => thread.seq === seq)

        const onEnter = (handler) => (event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
            event.preventDefault()
            handler()
          }
        }

        const composer = composing
          ? h('div', { className: 'fu-compose' },
            h('textarea', {
              className: 'fu-input',
              autoFocus: true,
              placeholder: '就这条回答说点什么、问点什么…（Enter 发送，Shift+Enter 换行）',
              value: draft,
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: onEnter(submitNew),
            }),
            h('div', { className: 'fu-row' },
              h('button', {
                className: 'fu-btn fu-primary',
                type: 'button',
                disabled: busy || !String(draft).trim(),
                onClick: submitNew,
              }, '发送'),
              h('button', {
                className: 'fu-btn',
                type: 'button',
                onClick: () => { setComposing(false) },
              }, '取消'),
              h('span', { className: 'fu-hint' }, '只在这条回答下面作答，不打断主对话，也不会新增左侧会话')))
          : null

        if (!mine.length) {
          if (!composing) {
            return h('div', { className: 'fu-root' },
              h('button', {
                className: 'fu-trigger',
                type: 'button',
                onClick: () => setComposing(true),
              }, '＋ 追问这条回答'))
          }
          return h('div', { className: 'fu-root' }, composer)
        }

        const running = mine.some((thread) => thread.status === 'running')
        const active = mine.find((thread) => thread.id === activeId) || null

        const items = panelOpen
          ? h('div', { className: 'fu-list' },
            mine.map((thread, index) => {
              const current = active !== null && active.id === thread.id
              const state = thread.status === 'running' ? '回答中…'
                : (thread.status === 'error' ? '失败' : null)
              const count = Array.isArray(thread.turns)
                ? thread.turns.filter((item) => item.role === 'user').length
                : 1
              return h('button', {
                className: 'fu-item' + (current ? ' fu-current' : ''),
                type: 'button',
                key: thread.id,
                title: titleOf(thread),
                onClick: () => pick(thread),
              },
                h('span', { className: 'fu-item-caret' }, current ? '▾' : '▸'),
                h('span', { className: 'fu-badge' }, String(index + 1)),
                h('span', { className: 'fu-item-q' }, titleOf(thread)),
                count > 1 ? h('span', { className: 'fu-item-state' }, count + ' 问') : null,
                state ? h('span', { className: 'fu-item-state' }, state) : null)
            }))
          : null

        const answer = (panelOpen && active)
          ? h('div', { className: 'fu-thread' },
            h('div', { className: 'fu-head' },
              h('span', { className: 'fu-badge' }, '追问'),
              h('span', { className: 'fu-hint' }, '这一串只在这条回答下面，不写进主对话')),
            (active.turns || []).map((item, index) => {
              const pending = item.status === 'running'
              const failed = item.status === 'error'
              return h('div', {
                key: String(index),
                className: 'fu-turn fu-turn-' + (item.role === 'user' ? 'user' : 'assistant'),
              },
                item.role === 'user'
                  ? h('div', { className: 'fu-q' },
                    active.turns.filter((other, at) => at < index && other.role === 'user').length > 0
                      ? '再问：' + item.text
                      : item.text)
                  : h('div', {
                    className: 'fu-a' + (pending ? ' fu-pending' : ''),
                  }, pending ? '正在回答…' : (item.text || (failed ? '（这一条没有回答成功）' : ''))))
            }),
            active.status === 'error' && h('div', { className: 'fu-error' }, active.error || '追问失败'),
            active.status === 'error' && active.diag && describeDiag(active.diag)
              ? h('div', { className: 'fu-error fu-diag' }, '诊断：' + describeDiag(active.diag))
              : null,
            h('div', { className: 'fu-meta' },
              active.status === 'error' && h('button', {
                className: 'fu-link', type: 'button', onClick: () => retry(active),
              }, '重试'),
              h('button', {
                className: 'fu-link',
                type: 'button',
                onClick: () => {
                  remove(active.id)
                  setActiveId(null)
                  rememberView(panelOpen, null)
                },
              }, '删除')),
            active.status === 'running'
              ? null
              : h('div', { className: 'fu-continue' },
                h('textarea', {
                  className: 'fu-input fu-input-sm',
                  rows: 2,
                  placeholder: '接着在这条追问里继续说…（Enter 发送，Shift+Enter 换行）',
                  value: reply,
                  onChange: (event) => setReply(event.target.value),
                  onKeyDown: onEnter(() => submitReply(active)),
                }),
                h('div', { className: 'fu-row' },
                  h('button', {
                    className: 'fu-btn fu-primary',
                    type: 'button',
                    disabled: busy || !String(reply).trim(),
                    onClick: () => submitReply(active),
                  }, '发送'),
                  h('span', { className: 'fu-hint' }, '这一串对话只留在这里，不会写进主对话'))))
          : null

        return h('div', { className: 'fu-root' },
          h('div', { className: 'fu-bar' },
            h('button', {
              className: 'fu-toggle',
              type: 'button',
              title: panelOpen ? '收起追问列表' : '展开追问列表，选择要看的回答',
              onClick: () => { if (panelOpen) closePanel(); else openPanel() },
            }, (panelOpen ? '▾ ' : '▸ ') + '追问 ' + mine.length + (running ? ' · 回答中…' : '')),
            h('button', {
              className: 'fu-trigger',
              type: 'button',
              onClick: () => { openPanel(); setComposing(true) },
            }, '＋ 追问')),
          items,
          answer,
          composing ? composer : null)
      }

      return FollowupThreads
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        let style = null
        ctx.effect(() => {
          style = document.createElement('style')
          style.setAttribute('data-followup-thread', '')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            if (style) style.remove()
            style = null
          }
        })
        const Component = createComponent(ctx)
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'followup-thread',
          order: 15,
        }, Component))
      },
    }
  },
})
