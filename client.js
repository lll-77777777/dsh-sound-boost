/**
 * dsh-sound-boost —— 浏览器半端
 * ============================================================================
 * ⭐ client bundle 是自注册脚本（不是 ESM）：
 *
 *     window.__ModuleLoader__.load({
 *       id: 'dsh-sound-boost',       // 必须等于 package.json 的 name
 *       factory: (require) => { ... return { inject, apply } },
 *     })
 *
 * 它做三件事：
 *   1. 监听会话状态：出现「审批」→ 放审批音；一轮跑完（running true→false）→ 放完成音
 *   2. 设置页（设置 → 提示音）：上传/试听/清除两种提示音，调音量
 *   3. 音频文件存本机 IndexedDB（不上传任何服务器），设置存 localStorage
 *
 * 监听用的是 uiSession.sessionStatus（官方可观察状态），不用去拦截审批
 * waterfall —— 那个是 ui-approval 的私有链路，拦截会破坏它的顺序。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-sound-boost',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /* ────────────── 常量 ────────────── */

    const DB_NAME = 'dsh-sound-boost'
    const STORE = 'clips'
    const LS_KEY = 'dsh-sound-boost:settings'
    const MAX_BYTES = 8 * 1024 * 1024
    const KINDS = ['approval', 'done']
    const KIND_LABEL = { approval: '需要批准', done: '任务完成' }
    const KIND_NOTE = {
      approval: 'DSH 弹出审批请求（等待你点「允许 / 拒绝」）时播放',
      done: '一轮对话跑完、助手回到空闲时播放',
    }
    const DEFAULTS = { enabled: true, approval: true, done: true, volume: 0.7 }
    const DEDUPE_MS = 2500

    /* 默认提示音（没上传文件时用，现场合成，不带音频资源） */
    const DEFAULT_NOTES = {
      approval: [{ freq: 880, dur: 0.1 }, { freq: 880, dur: 0.13 }],
      done: [{ freq: 523.25, dur: 0.1 }, { freq: 659.25, dur: 0.1 }, { freq: 783.99, dur: 0.2 }],
    }

    /* ────────────── 设置（localStorage） ────────────── */

    function loadSettings() {
      let raw = null
      try { raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null') } catch { /* 坏数据当默认 */ }
      const s = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {})
      const v = Number(s.volume)
      s.volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULTS.volume
      for (const key of ['enabled', 'approval', 'done']) s[key] = s[key] !== false
      return s
    }

    function saveSettings(patch) {
      const s = Object.assign(loadSettings(), patch || {})
      try { localStorage.setItem(LS_KEY, JSON.stringify(s)) } catch { /* 隐私模式写不了，能响就行 */ }
      return s
    }

    /* ────────────── 音频文件（IndexedDB） ────────────── */

    let dbPromise
    function db() {
      if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
          const req = indexedDB.open(DB_NAME, 1)
          req.onupgradeneeded = () => {
            const d = req.result
            if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE)
          }
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
      }
      return dbPromise
    }

    async function getClip(kind) {
      const d = await db()
      return await new Promise((resolve, reject) => {
        const tx = d.transaction(STORE, 'readonly')
        const req = tx.objectStore(STORE).get(kind)
        req.onsuccess = () => resolve(req.result || null)
        req.onerror = () => reject(req.error)
      })
    }

    async function putClip(kind, file) {
      const bytes = await file.arrayBuffer()
      const d = await db()
      await new Promise((resolve, reject) => {
        const tx = d.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put({
          name: file.name,
          mime: file.type || 'application/octet-stream',
          size: bytes.byteLength,
          bytes,
        }, kind)
        tx.oncomplete = resolve
        tx.onerror = () => reject(tx.error)
      })
    }

    async function delClip(kind) {
      const d = await db()
      await new Promise((resolve, reject) => {
        const tx = d.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).delete(kind)
        tx.oncomplete = resolve
        tx.onerror = () => reject(tx.error)
      })
    }

    /* ────────────── 播放引擎（WebAudio） ────────────── */

    let audioCtx = null
    let unlocked = false
    const bufferCache = new Map() // kind -> { key, buffer }

    function getAudioCtx() {
      if (!audioCtx) {
        const Ctor = window.AudioContext || window.webkitAudioContext
        if (!Ctor) return null
        audioCtx = new Ctor()
      }
      return audioCtx
    }

    function tryUnlock() {
      const ctx = getAudioCtx()
      if (!ctx) return
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})
      unlocked = true
    }

    function synthNotes(ctx, notes) {
      let total = 0
      for (const n of notes) total += n.dur + (n.gap == null ? 0.02 : n.gap)
      const buf = ctx.createBuffer(1, Math.max(1, Math.ceil(total * ctx.sampleRate)), ctx.sampleRate)
      const channel = buf.getChannelData(0)
      let t0 = 0
      for (const n of notes) {
        const start = Math.floor(t0 * ctx.sampleRate)
        const len = Math.floor(n.dur * ctx.sampleRate)
        for (let i = 0; i < len; i++) {
          const t = i / ctx.sampleRate
          const fadeIn = Math.min(1, t / 0.006)
          const fadeOut = Math.min(1, Math.max(0, (n.dur - t) / 0.02))
          channel[start + i] = Math.sin(2 * Math.PI * n.freq * t) * 0.32 * fadeIn * fadeOut
        }
        t0 += n.dur + (n.gap == null ? 0.02 : n.gap)
      }
      return buf
    }

    async function ensureBuffer(kind) {
      const clip = await getClip(kind).catch(() => null)
      const cacheKey = clip ? clip.name + ':' + clip.size : 'default'
      const cached = bufferCache.get(kind)
      if (cached && cached.key === cacheKey) return cached.buffer
      const ctx = getAudioCtx()
      if (!ctx) return null
      let buffer = null
      if (clip && clip.bytes) {
        try {
          buffer = await ctx.decodeAudioData(clip.bytes.slice(0))
        } catch {
          buffer = null // 浏览器解不了这个格式，退回默认音
        }
      }
      if (!buffer) buffer = synthNotes(ctx, DEFAULT_NOTES[kind] || DEFAULT_NOTES.done)
      bufferCache.set(kind, { key: cacheKey, buffer })
      return buffer
    }

    async function play(kind, force) {
      if (!force) {
        const s = loadSettings()
        if (!s.enabled || !s[kind]) return
      }
      const ctx = getAudioCtx()
      if (!ctx) return
      if (ctx.state === 'suspended') {
        try { await ctx.resume() } catch { return }
      }
      const buffer = await ensureBuffer(kind)
      if (!buffer) return
      const gain = ctx.createGain()
      gain.gain.value = loadSettings().volume
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(gain).connect(ctx.destination)
      source.start()
    }

    /* ────────────── 会话状态监听 ────────────── */

    function watchSessionStatus(ctx) {
      const ui = ctx.uiSession
      const store = ui && ui.sessionStatus
      if (!store || typeof store.subscribe !== 'function') return () => {}

      const isSubagent = (sessionId) => {
        try {
          const list = ctx.sessions && ctx.sessions.list
          const snapshot = list && list.getSnapshot()
          const row = snapshot && snapshot.byId && snapshot.byId[sessionId]
          return !!(row && row.subagent)
        } catch {
          return false
        }
      }

      let previous = store.getSnapshot()
      const played = new Map()
      const allow = (kind, sessionId) => {
        const key = kind + ':' + sessionId
        const now = Date.now()
        if (now - (played.get(key) || 0) < DEDUPE_MS) return false
        played.set(key, now)
        if (played.size > 200) played.clear()
        return true
      }

      return store.subscribe(() => {
        const next = store.getSnapshot()
        try {
          for (const [sessionId, status] of next) {
            const before = previous.get(sessionId)
            if (!before || !status) continue
            const hadPending = before.pendingInteraction != null
            const hasPending = status.pendingInteraction != null
            // 出现审批（plan-review / 普通提问不算）
            if (!hadPending && hasPending
              && status.pendingInteraction.kind === 'approval'
              && allow('approval', sessionId)) {
              play('approval')
            }
            // 一轮跑完（subagent 的结束不响，免得吵）
            if (before.running === true && status.running === false
              && !isSubagent(sessionId)
              && allow('done', sessionId)) {
              play('done')
            }
          }
        } catch (error) {
          console.warn('[dsh-sound-boost] 状态处理失败', error)
        }
        previous = next
      })
    }

    /* ────────────── 设置页 ────────────── */

    const CSS = `
[data-sb-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 10px;max-width:660px;}
[data-sb-sec]{display:flex;flex-direction:column;gap:8px;}
[data-sb-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-sb-row]{display:flex;align-items:center;gap:10px;}
[data-sb-grow]{flex:1;min-width:0;}
[data-sb-label]{font-size:13px;}
[data-sb-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-sb-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-sb-sw][data-on]{background:#3b82f6;}
[data-sb-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-sb-sw][data-on] i{left:19px;}
[data-sb-sw][disabled]{opacity:.45;cursor:default;}
[data-sb-card]{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
  background:var(--dsw-alias-bg-l2,rgba(255,255,255,.03));}
[data-sb-file]{font-size:12px;color:var(--dsw-alias-label-secondary,#b0b6bd);word-break:break-all;}
[data-sb-file] b{font-weight:500;color:var(--dsw-alias-label-primary,inherit);}
[data-sb-file] span{color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-sb-btns]{display:flex;gap:8px;flex-wrap:wrap;}
[data-sb-btn]{padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-l2,rgba(255,255,255,.05));color:inherit;}
[data-sb-btn]:hover{background:var(--dsw-alias-bg-l3,rgba(255,255,255,.1));}
[data-sb-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-sb-btn][data-primary]:hover{background:#2f6fd8;}
[data-sb-btn][disabled]{opacity:.5;cursor:default;}
[data-sb-range]{width:180px;flex:none;accent-color:#3b82f6;}
[data-sb-vol]{font-size:12px;min-width:38px;text-align:right;color:var(--dsw-alias-label-secondary,#b0b6bd);}
[data-sb-hint]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-sb-msg]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#b0b6bd);white-space:pre-wrap;}
[data-sb-msg][data-err]{color:#ff453a;}
[data-sb-tag]{display:inline-block;padding:1px 7px;border-radius:6px;font-size:11px;
  background:var(--dsw-alias-bg-l3,rgba(128,128,128,.2));color:var(--dsw-alias-label-secondary,#b0b6bd);}
`

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-sb-sw': '',
        'data-on': on ? '' : undefined,
        disabled: !!disabled,
        title: on ? '已开启' : '已关闭',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function Btn({ children, onClick, primary, disabled, title }) {
      return h('button', {
        'data-sb-btn': '',
        'data-primary': primary ? '' : undefined,
        disabled: !!disabled,
        title,
        onClick,
      }, children)
    }

    function Panel() {
      const [settings, setSettings] = React.useState(loadSettings)
      const [clips, setClips] = React.useState({ approval: null, done: null })
      const [message, setMessage] = React.useState('')
      const [messageIsError, setMessageIsError] = React.useState(false)
      const [busy, setBusy] = React.useState('')
      const fileRef = React.useRef(null)
      const pendingKind = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          const loaded = {}
          for (const kind of KINDS) loaded[kind] = await getClip(kind).catch(() => null)
          if (alive) setClips(loaded)
        })()
        return () => { alive = false }
      }, [])

      const notify = (text, isError) => {
        setMessage(text)
        setMessageIsError(!!isError)
      }

      const update = (patch) => setSettings(saveSettings(patch))

      const chooseFile = (kind) => {
        pendingKind.current = kind
        const input = fileRef.current
        if (!input) return
        input.value = ''
        input.click()
      }

      const onFileChange = async (event) => {
        const file = event.target.files && event.target.files[0]
        const kind = pendingKind.current
        pendingKind.current = null
        if (!file || !kind) return
        if (file.size > MAX_BYTES) {
          notify(`文件太大了：${(file.size / 1048576).toFixed(1)} MB（上限 ${MAX_BYTES / 1048576} MB）`, true)
          return
        }
        if (file.size === 0) {
          notify('这个文件是空的', true)
          return
        }
        setBusy(kind)
        notify('')
        try {
          await putClip(kind, file)
          bufferCache.delete(kind)
          setClips((current) => Object.assign({}, current, { [kind]: { name: file.name, size: file.size } }))
          notify(`已保存 ${KIND_LABEL[kind]} 提示音：${file.name}`)
          await play(kind, true)
        } catch (error) {
          notify('保存失败：' + ((error && error.message) || error), true)
        }
        setBusy('')
      }

      const clearClip = async (kind) => {
        try {
          await delClip(kind)
          bufferCache.delete(kind)
          setClips((current) => Object.assign({}, current, { [kind]: null }))
          notify(`${KIND_LABEL[kind]} 提示音已恢复默认`)
        } catch (error) {
          notify('清除失败：' + ((error && error.message) || error), true)
        }
      }

      const preview = async (kind) => {
        try {
          await play(kind, true)
        } catch (error) {
          notify('播放失败：' + ((error && error.message) || error), true)
        }
      }

      const volumePercent = Math.round(settings.volume * 100)

      const clipSection = (kind) => {
        const clip = clips[kind]
        const sizeText = clip && clip.size ? `${(clip.size / 1024).toFixed(1)} KB` : ''
        return h('div', { 'data-sb-card': '' },
          h('div', { 'data-sb-row': '' },
            h('div', { 'data-sb-grow': '' },
              h('div', { 'data-sb-label': '' }, KIND_LABEL[kind]),
              h('div', { 'data-sb-note': '' }, KIND_NOTE[kind])),
            h(Switch, {
              on: !!settings[kind],
              disabled: !settings.enabled,
              onChange: (on) => update({ [kind]: on }),
            })),
          h('div', { 'data-sb-file': '' },
            clip
              ? h(React.Fragment, null, '当前文件：', h('b', null, clip.name), ' ', h('span', null, sizeText))
              : h(React.Fragment, null, '当前：', h('b', null, '默认提示音'), ' ', h('span', null, `（${kind === 'approval' ? '叮·叮 两声' : '上行三音'}）`))),
          h('div', { 'data-sb-btns': '' },
            h(Btn, { primary: true, disabled: busy === kind, onClick: () => chooseFile(kind) }, busy === kind ? '保存中…' : '上传音频文件'),
            h(Btn, { onClick: () => preview(kind), title: '按当前音量播放一次' }, '试听'),
            clip ? h(Btn, { onClick: () => clearClip(kind) }, '恢复默认') : null),
          h('div', { 'data-sb-hint': '' },
            '支持 mp3 / wav / ogg / m4a 等浏览器能解码的格式，最大 8 MB。文件只存在这台电脑的浏览器里，不会上传。'))
      }

      return h('div', { 'data-sb-page': '' },
        h('input', {
          type: 'file',
          accept: 'audio/*',
          ref: fileRef,
          style: { display: 'none' },
          onChange: onFileChange,
        }),
        h('div', { 'data-sb-sec': '' },
          h('div', { 'data-sb-h': '' }, '提示音'),
          h('div', { 'data-sb-row': '' },
            h('div', { 'data-sb-grow': '' },
              h('div', { 'data-sb-label': '' }, '启用提示音'),
              h('div', { 'data-sb-note': '' }, '关掉之后两种提示音都不响（上传的文件会留着）')),
            h(Switch, { on: !!settings.enabled, onChange: (on) => update({ enabled: on }) }))),
        h('div', { 'data-sb-sec': '' },
          h('div', { 'data-sb-h': '' }, '两种声音'),
          clipSection('approval'),
          clipSection('done')),
        h('div', { 'data-sb-sec': '' },
          h('div', { 'data-sb-h': '' }, '音量'),
          h('div', { 'data-sb-row': '' },
            h('input', {
              'data-sb-range': '',
              type: 'range',
              min: 0,
              max: 100,
              step: 1,
              value: volumePercent,
              onChange: (event) => update({ volume: Number(event.target.value) / 100 }),
            }),
            h('span', { 'data-sb-vol': '' }, volumePercent + '%'))),
        h('div', { 'data-sb-sec': '' },
          h('div', { 'data-sb-h': '' }, '说明'),
          h('div', { 'data-sb-hint': '' },
            '提示音在 DSH 页面里播放：切到别的窗口也能听见；浏览器标签页被系统挂起（休眠）时不会响。',
            h('br'),
            '「需要批准」只对审批弹窗生效，计划审阅和普通提问不响；「任务完成」在一轮对话结束时响，子代理跑完不响。'),
          message ? h('div', { 'data-sb-msg': '', 'data-err': messageIsError ? '' : undefined }, message) : null))
    }

    /* ────────────── 插件入口 ────────────── */

    return {
      inject: ['uiSession', 'sessions', 'slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-sound-boost')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-sound-boost: 设置页样式')

        // 浏览器要求用户先交互过才能出声；第一次点击/按键时解锁 AudioContext
        const unlock = () => {
          tryUnlock()
          document.removeEventListener('pointerdown', unlock, true)
          window.removeEventListener('keydown', unlock, true)
        }
        document.addEventListener('pointerdown', unlock, true)
        window.addEventListener('keydown', unlock, true)
        if (unlocked) {
          document.removeEventListener('pointerdown', unlock, true)
          window.removeEventListener('keydown', unlock, true)
        }
        ctx.effect(() => () => {
          document.removeEventListener('pointerdown', unlock, true)
          window.removeEventListener('keydown', unlock, true)
        }, 'dsh-sound-boost: 音频解锁监听')

        // 全局提醒：任何会话出现审批、或一轮完成，都出声
        ctx.effect(() => watchSessionStatus(ctx), 'dsh-sound-boost: 会话状态监听')

        // 设置页
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'sound-boost', order: 45, label: '提示音' },
          () => h(Panel),
        ))
      },
    }
  },
})
