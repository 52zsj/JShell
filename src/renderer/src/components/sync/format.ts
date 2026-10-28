const pad = (n: number): string => String(n).padStart(2, '0')

/** ISO 字符串 -> 2026-10-27 16:30；解析不了就原样返回，避免显示 Invalid Date */
export function formatTime(value?: string): string {
  if (!value) return '未知时间'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
