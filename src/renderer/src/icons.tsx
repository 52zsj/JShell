import type { SVGProps } from 'react'

/**
 * 手写图标集：项目不引入图标库，减少依赖体积与后续维护成本。
 * 统一 24x24 viewBox、1.8 描边、currentColor 继承文字色。
 */
const base: SVGProps<SVGSVGElement> = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true
}

export const IconPlus = () => (
  <svg {...base}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const IconClose = () => (
  <svg {...base}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)

export const IconTerminal = () => (
  <svg {...base}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M7 9.5l3 2.5-3 2.5M13 15h4" />
  </svg>
)

export const IconFolder = () => (
  <svg {...base}>
    <path d="M3 7.5A2 2 0 015 5.5h3.6a2 2 0 011.5.7l1 1.3H19a2 2 0 012 2v7a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
  </svg>
)

export const IconFile = () => (
  <svg {...base}>
    <path d="M14 3v5h5" />
    <path d="M19 8.5V19a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2h7z" />
  </svg>
)

export const IconLink = () => (
  <svg {...base}>
    <path d="M10 13.5a4 4 0 005.7 0l2.8-2.8a4 4 0 00-5.7-5.7L11.5 6.3" />
    <path d="M14 10.5a4 4 0 00-5.7 0L5.5 13.3a4 4 0 005.7 5.7l1.3-1.3" />
  </svg>
)

export const IconServer = () => (
  <svg {...base}>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </svg>
)

export const IconSettings = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z" />
  </svg>
)

export const IconUpload = () => (
  <svg {...base}>
    <path d="M12 16V4M7 9l5-5 5 5" />
    <path d="M4 16v2.5A2.5 2.5 0 006.5 21h11A2.5 2.5 0 0020 18.5V16" />
  </svg>
)

export const IconDownload = () => (
  <svg {...base}>
    <path d="M12 4v12M7 11l5 5 5-5" />
    <path d="M4 16v2.5A2.5 2.5 0 006.5 21h11A2.5 2.5 0 0020 18.5V16" />
  </svg>
)

export const IconRefresh = () => (
  <svg {...base}>
    <path d="M20 12a8 8 0 10-2.6 5.9" />
    <path d="M20 5v5h-5" />
  </svg>
)

export const IconChevronLeft = () => (
  <svg {...base}>
    <path d="M14 6l-6 6 6 6" />
  </svg>
)

export const IconTrash = () => (
  <svg {...base}>
    <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12" />
    <path d="M10 11v6M14 11v6" />
  </svg>
)

export const IconEdit = () => (
  <svg {...base}>
    <path d="M4 20h4L19 9a2.5 2.5 0 00-3.5-3.5L4 16.5z" />
    <path d="M14 6.5l3.5 3.5" />
  </svg>
)

export const IconSearch = () => (
  <svg {...base}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4 4" />
  </svg>
)

export const IconCode = () => (
  <svg {...base}>
    <path d="M9 8l-4 4 4 4M15 8l4 4-4 4" />
  </svg>
)

export const IconKey = () => (
  <svg {...base}>
    <circle cx="8" cy="8" r="3.5" />
    <path d="M10.5 10.5L20 20M17 17l-2 2M14.5 14.5L17 12" />
  </svg>
)

export const IconArrowRight = () => (
  <svg {...base}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
)

export const IconSplitRight = () => (
  <svg {...base}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M12 4v16" />
  </svg>
)

export const IconSplitDown = () => (
  <svg {...base}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M3 12h18" />
  </svg>
)

export const IconLaptop = () => (
  <svg {...base}>
    <rect x="4" y="4.5" width="16" height="11" rx="1.8" />
    <path d="M2 19h20" />
  </svg>
)

export const IconRotate = () => (
  <svg {...base}>
    <path d="M4 12a8 8 0 1014.9-4" />
    <path d="M20 4v5h-5" />
  </svg>
)

export const IconLocate = () => (
  <svg {...base}>
    <path d="M3 7.5A1.5 1.5 0 014.5 6h4l2 2h7A1.5 1.5 0 0119 9.5v7A1.5 1.5 0 0117.5 18h-13A1.5 1.5 0 013 16.5z" />
    <circle cx="12.5" cy="13" r="2.5" />
    <path d="M14.4 14.9L16.5 17" />
  </svg>
)

export const IconSync = () => (
  <svg {...base}>
    <path d="M4 12a8 8 0 0113.7-5.6L20 8" />
    <path d="M20 4v4h-4" />
    <path d="M20 12a8 8 0 01-13.7 5.6L4 16" />
    <path d="M4 20v-4h4" />
  </svg>
)

export const IconSave = () => (
  <svg {...base}>
    <path d="M4 5.5A1.5 1.5 0 015.5 4h9L19 8.5v10A1.5 1.5 0 0117.5 20h-12A1.5 1.5 0 014 18.5z" />
    <path d="M8 4v5h7V4" />
    <path d="M8 20v-5.5h8V20" />
  </svg>
)

export const IconList = () => (
  <svg {...base}>
    <path d="M8 6h12M8 12h12M8 18h12" />
    <circle cx="4.5" cy="6" r="1" />
    <circle cx="4.5" cy="12" r="1" />
    <circle cx="4.5" cy="18" r="1" />
  </svg>
)

export const IconTree = () => (
  <svg {...base}>
    <rect x="2.5" y="3" width="6" height="4.5" rx="1" />
    <rect x="15" y="9.5" width="6" height="4.5" rx="1" />
    <rect x="15" y="16.5" width="6" height="4.5" rx="1" />
    <path d="M8.5 5.25h3.5v13.5h3M12 5.25v6.75h3" />
  </svg>
)

export const IconChevronRight = () => (
  <svg {...base}>
    <path d="M9 6l6 6-6 6" />
  </svg>
)

export const IconChevronDown = () => (
  <svg {...base}>
    <path d="M6 9l6 6 6-6" />
  </svg>
)

export const IconHome = () => (
  <svg {...base}>
    <path d="M4 10.5L12 4l8 6.5V20a1 1 0 01-1 1h-5v-6h-4v6H5a1 1 0 01-1-1z" />
  </svg>
)

export const IconCloud = () => (
  <svg {...base}>
    <path d="M7.5 18.5h9a3.5 3.5 0 00.4-6.98A5 5 0 007.2 10.6a3.96 3.96 0 00.3 7.9z" />
  </svg>
)

export const IconClipboard = () => (
  <svg {...base}>
    <rect x="5" y="4.5" width="14" height="16" rx="2" />
    <path d="M9 4.5V3.8A1.8 1.8 0 0110.8 2h2.4A1.8 1.8 0 0115 3.8v.7z" />
    <path d="M9 11h6M9 15h4" />
  </svg>
)

export const IconShield = () => (
  <svg {...base}>
    <path d="M12 3l7 3v5.5c0 4.2-2.9 7.6-7 9.5-4.1-1.9-7-5.3-7-9.5V6z" />
    <path d="M9.5 12.2l1.8 1.8 3.4-3.6" />
  </svg>
)
