/**
 * Follow-up thread — Client half.
 *
 * Adds an inline "追问" thread under every completed answer: the question and
 * its answer render together, at the place the question is about, instead of
 * as a detached turn at the bottom of the conversation.
 *
 * Answers come from this plugin's own Host route (./api/followup-thread/ask),
 * which replays the conversation context up to this answer and asks the model
 * directly. No child Session is created, so nothing appears in the left
 * workspace. Threads live in localStorage, per Session.
 */

window.__ModuleLoader__.load({
  id: '@local/followup-thread',
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
.fu-thread { border: 0.5px solid var(--dsw-alias-border-l4, #e5e7eb); border-left: 2px solid var(--dsw-alias-state-business-primary, #4f46e5); border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.02)); padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.fu-head { display: flex; align-items: center; gap: 8px; }
.fu-badge { flex: none; font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 999px; color: var(--dsw-alias-label-secondary, #6b7280); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }
.fu-q { color: var(--dsw-alias-label-primary, #111827); font-size: 13.5px; line-height: 21px; white-space: pre-wrap; word-break: break-word; }
.fu-a { color: var(--dsw-alias-label-primary, #111827); font-size: 13.5px; line-height: 22px; white-space: pre-wrap; word-break: break-word; }
.fu-a.fu-pending { color: var(--dsw-alias-label-secondary, #6b7280); }
.fu-meta { display: flex; align-items: center; gap: 10px; }
.fu-link { border: 0; background: transparent; padding: 0; cursor: pointer; color: var(--dsw-alias-state-business-primary, #4f46e5); font: inherit; font-size: 12px; }
.fu-error { color: var(--dsw-alias-state-error-primary, #b91c1c); font-size: 12px; line-height: 18px; }
.fu-compose { display: flex; flex-direction: column; gap: 8px; border: 0.5px solid var(--dsw-alias-border-l4, #e5e7eb); border-radius: var(--dsw-radius-lg, 10px); padding: 10px 12px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.02)); }
.fu-input { box-sizing: border-box; width: 100%; min-height: 62px; max-height: 220px; resize: vertical; border: 0.5px solid var(--dsw-alias-border-l4, #e5e7eb); border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-primary, #111827); font: inherit; font-size: 13.5px; line-height: 21px; padding: 8px 10px; }
.fu-input:focus { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4f46e5)); outline-offset: 1px; }
.fu-row { display: flex; align-items: center; gap: 8px; }
.fu-btn { height: 28px; padding: 0 12px; border-radius: var(--dsw-radius-sm, 6px); border: 0.5px solid var(--dsw-alias-border-l4, #e5e7eb); background: transparent; color: var(--dsw-alias-label-primary, #111827); font: inherit; font-size: 13px; cursor: pointer; }
.fu-btn.fu-primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, #4f46e5); color: var(--dsw-alias-label-primary-foreground, #fff); }
.fu-btn:disabled { opacity: 0.5; cursor: default; }
.fu-hint { color: var(--dsw-alias-label-secondary, #6b7280); font-size: 11.5px; }
`

    function readThreads(sessionId) {
      try {
        const raw = window.localStorage.getItem(STORAGE_PREFIX + sessionId)
        const parsed = raw ? JSON.parse(raw) : []
        return Array.isArray(parsed) ? parsed : []
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

    /**
     * Ask this plugin's Host route for an answer to `question` about the state
     * of the conversation as of `seq`. No Session is created for it.
     */
    async function askHost(sessionId, seq, question) {
      const body = { sessionId, question }
      if (typeof seq === 'number') body.atSeq = seq
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

    function createComponent(ctx) {
      async function run(sessionId, seq, threadId, question) {
        try {
          const answer = await askHost(sessionId, seq, question)
          patchThread(sessionId, threadId, { status: 'done', answer, error: null, diag: null })
        } catch (error) {
          const message = error && error.message ? error.message : String(error)
          const diag = error && error.diag ? error.diag : null
          patchThread(sessionId, threadId, { status: 'error', error: message, diag })
        }
      }

      function submit(sessionId, seq, question, setBusy, setDraft, setComposing, activate) {
        const text = String(question || '').trim()
        if (!text) return
        const thread = {
          id: newId('followup-thread-'),
          seq,
          question: text,
          answer: '',
          status: 'running',
          error: null,
          createdAt: Date.now(),
        }
        writeThreads(sessionId, readThreads(sessionId).concat([thread]))
        setDraft('')
        setComposing(false)
        setBusy(true)
        if (typeof activate === 'function') activate(thread.id)
        run(sessionId, seq, thread.id, text).then(() => setBusy(false))
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

        const retry = (thread) => {
          setBusy(true)
          setActiveId(thread.id)
          rememberView(true, thread.id)
          patchThread(sessionId, thread.id, { status: 'running', error: null, answer: '' })
          run(sessionId, seq, thread.id, thread.question).then(() => setBusy(false))
        }

        if (!sessionId || typeof seq !== 'number') return null
        const mine = threads.filter((thread) => thread.seq === seq)

        const composer = composing
          ? h('div', { className: 'fu-compose' },
            h('textarea', {
              className: 'fu-input',
              autoFocus: true,
              placeholder: '就这条回答说点什么、问点什么…（Enter 发送，Shift+Enter 换行）',
              value: draft,
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                  event.preventDefault()
                  submit(sessionId, seq, draft, setBusy, setDraft, setComposing, (id) => {
                    setActiveId(id)
                    setPanelOpen(true)
                    rememberView(true, id)
                  })
                }
              },
            }),
            h('div', { className: 'fu-row' },
              h('button', {
                className: 'fu-btn fu-primary',
                type: 'button',
                disabled: busy || !String(draft).trim(),
                onClick: () => submit(sessionId, seq, draft, setBusy, setDraft, setComposing, (id) => {
                  setActiveId(id)
                  setPanelOpen(true)
                  rememberView(true, id)
                }),
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
              return h('button', {
                className: 'fu-item' + (current ? ' fu-current' : ''),
                type: 'button',
                key: thread.id,
                title: thread.question,
                onClick: () => pick(thread),
              },
                h('span', { className: 'fu-item-caret' }, current ? '▾' : '▸'),
                h('span', { className: 'fu-badge' }, String(index + 1)),
                h('span', { className: 'fu-item-q' }, thread.question),
                state ? h('span', { className: 'fu-item-state' }, state) : null)
            }))
          : null

        const answer = (panelOpen && active)
          ? h('div', { className: 'fu-thread' },
            h('div', { className: 'fu-head' },
              h('span', { className: 'fu-badge' }, '追问'),
              h('span', { className: 'fu-q' }, active.question)),
            h('div', {
              className: 'fu-a' + (active.status === 'running' && !active.answer ? ' fu-pending' : ''),
            }, active.status === 'running' && !active.answer ? '正在回答…' : active.answer),
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
              }, '删除')))
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
