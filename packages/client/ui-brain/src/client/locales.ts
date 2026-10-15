/** Copy keys for the Asel's Brain sidebar section. */
export type BrainKey =
  | 'section'
  | 'search.aria'
  | 'search.placeholder'
  | 'search.clear'
  | 'empty.unconfigured'
  | 'empty.none'
  | 'search.noMatches'
  | 'loading'
  | 'error'
  | 'back'
  | 'note.untitled'
  | 'open.aria'
  | 'close'
  | 'vault'
  | 'search.placeholderAll'
  | 'search.results'
  | 'reader.empty'
  | 'copy.text'
  | 'copy.path'
  | 'copied'
  | 'retry'
  | 'hint.close'

export const en: Record<BrainKey, string> = {
  section: "Asel's Brain",
  'search.aria': 'Search notes',
  'search.placeholder': 'Search notes',
  'search.clear': 'Clear search',
  'empty.unconfigured': 'No vault configured. Set its path in Settings → Plugins → Brain.',
  'empty.none': 'No notes yet.',
  'search.noMatches': 'No matching notes.',
  loading: 'Loading notes…',
  error: 'Could not load your notes.',
  back: 'Back',
  'note.untitled': 'Untitled',
  'open.aria': "Open Asel's Brain",
  close: 'Close',
  vault: 'Vault',
  'search.placeholderAll': 'Search all notes…',
  'search.results': 'Search results',
  'reader.empty': 'Choose a note on the left to read it here.',
  'copy.text': 'Copy text',
  'copy.path': 'Copy path',
  copied: 'Copied',
  retry: 'Try again',
  'hint.close': 'Esc to close',
}

export const zh: Record<BrainKey, string> = {
  section: 'Asel 的大脑',
  'search.aria': '搜索笔记',
  'search.placeholder': '搜索笔记',
  'search.clear': '清除搜索',
  'empty.unconfigured': '尚未配置知识库。请在 设置 → 插件 → Brain 中设置路径。',
  'empty.none': '还没有笔记。',
  'search.noMatches': '没有匹配的笔记。',
  loading: '正在加载笔记…',
  error: '无法加载笔记。',
  back: '返回',
  'note.untitled': '未命名',
  'open.aria': '打开 Asel 的大脑',
  close: '关闭',
  vault: '知识库',
  'search.placeholderAll': '搜索全部笔记…',
  'search.results': '搜索结果',
  'reader.empty': '在左侧选择一篇笔记即可在此阅读。',
  'copy.text': '复制内容',
  'copy.path': '复制路径',
  copied: '已复制',
  retry: '重试',
  'hint.close': '按 Esc 关闭',
}
