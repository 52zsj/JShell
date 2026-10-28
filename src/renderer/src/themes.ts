import type { ITheme } from '@xterm/xterm'

export interface TerminalThemePreset {
  id: string
  name: string
  /** 用于设置面板的色板预览 */
  swatch: [string, string, string]
  theme: ITheme
}

/**
 * 终端配色方案。
 * 只影响 xterm 画布内部，应用外壳使用 CSS 变量（跟随 settings.theme）。
 */
export const TERMINAL_THEMES: TerminalThemePreset[] = [
  {
    id: 'one-dark',
    name: '夜幕黑',
    swatch: ['#282c34', '#98c379', '#61afef'],
    theme: {
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#528bff',
      cursorAccent: '#282c34',
      selectionBackground: '#3e4451',
      black: '#1e2127',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#d19a66',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf',
      brightBlack: '#5c6370',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#e5c07b',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'dracula',
    name: '德古拉',
    swatch: ['#282a36', '#50fa7b', '#bd93f9'],
    theme: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: '#44475a',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'nord',
    name: '极地蓝',
    swatch: ['#2e3440', '#a3be8c', '#88c0d0'],
    theme: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      cursorAccent: '#2e3440',
      selectionBackground: '#434c5e',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4'
    }
  },
  {
    id: 'gruvbox-dark',
    name: '暖褐夜色',
    swatch: ['#282828', '#b8bb26', '#83a598'],
    theme: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      cursorAccent: '#282828',
      selectionBackground: '#504945',
      black: '#282828',
      red: '#fb4934',
      green: '#b8bb26',
      yellow: '#fabd2f',
      blue: '#83a598',
      magenta: '#d3869b',
      cyan: '#8ec07c',
      white: '#ebdbb2',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#fbf1c7'
    }
  },
  {
    id: 'github-light',
    name: '清亮白',
    swatch: ['#ffffff', '#28a745', '#0366d6'],
    theme: {
      background: '#ffffff',
      foreground: '#24292e',
      cursor: '#24292e',
      cursorAccent: '#ffffff',
      selectionBackground: '#c8e1ff',
      black: '#24292e',
      red: '#d73a49',
      green: '#28a745',
      yellow: '#b08800',
      blue: '#0366d6',
      magenta: '#ea4aaa',
      cyan: '#1b7c83',
      white: '#6a737d',
      brightBlack: '#959da5',
      brightRed: '#cb2431',
      brightGreen: '#22863a',
      brightYellow: '#b08800',
      brightBlue: '#005cc5',
      brightMagenta: '#d73a49',
      brightCyan: '#3192aa',
      brightWhite: '#d1d5da'
    }
  },
  {
    id: 'solarized-light',
    name: '暖阳纸',
    swatch: ['#fdf6e3', '#859900', '#268bd2'],
    theme: {
      background: '#fdf6e3',
      foreground: '#657b83',
      cursor: '#586e75',
      cursorAccent: '#fdf6e3',
      selectionBackground: '#eee8d5',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#002b36',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3'
    }
  }
]

export function getTerminalTheme(id: string): ITheme {
  return (TERMINAL_THEMES.find((t) => t.id === id) ?? TERMINAL_THEMES[0]).theme
}
