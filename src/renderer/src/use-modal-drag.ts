import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from 'react'

interface Point {
  x: number
  y: number
}

/** 拖到视口边缘时至少保留这么多像素，避免把弹窗丢到看不见的地方 */
const KEEP_VISIBLE_X = 80
const KEEP_VISIBLE_Y = 40

/** 头部里这些元素自己要用指针事件（点按钮、拖选输入框里的文字），不当拖动把手 */
const INTERACTIVE = 'button, input, textarea, select, a, label, [role="button"]'

export interface ModalDrag<T extends HTMLElement = HTMLDivElement> {
  /** 挂到 `.modal` 上 */
  modalRef: RefObject<T>
  /** 挂到 `.modal-head` 上 */
  handleProps: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
  }
  /** 挂到 `.modal` 的 style 上 */
  style: CSSProperties
  dragging: boolean
}

/**
 * 让弹窗可以拖着头移动。
 *
 * 弹窗本来靠 `.modal-mask`（grid + place-items center）居中，所以这里用
 * `transform: translate()` 叠一个偏移，不改布局——拖动结束松手时位置就停在那儿，
 * 关闭后组件卸载，下次打开又是居中的。
 *
 * 边界：整块拖不出视口，至少留 80px 宽度 / 40px 高度可见，
 * 免得用户把弹窗丢到屏幕外再也找不回来。
 */
export function useModalDrag<T extends HTMLElement = HTMLDivElement>(): ModalDrag<T> {
  const modalRef = useRef<T>(null)
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ px: number; py: number; base: Point; origin: DOMRect } | null>(null)
  const frame = useRef<number | null>(null)
  const pending = useRef<Point | null>(null)
  const offsetRef = useRef<Point>(offset)

  const flush = useCallback(() => {
    frame.current = null
    const next = pending.current
    if (!next) return
    offsetRef.current = next
    setOffset(next)
  }, [])

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const info = start.current
      if (!info) return
      const dx = event.clientX - info.px
      const dy = event.clientY - info.py
      const { origin, base } = info

      // 允许的偏移范围：保证弹窗不会整块移出视口
      const minX = KEEP_VISIBLE_X - origin.right
      const maxX = window.innerWidth - KEEP_VISIBLE_X - origin.left
      const minY = -origin.top
      const maxY = window.innerHeight - KEEP_VISIBLE_Y - origin.top
      const clamp = (value: number, lo: number, hi: number): number =>
        hi < lo ? lo : Math.min(hi, Math.max(lo, value))

      const next = {
        x: clamp(base.x + dx, minX, maxX),
        y: clamp(base.y + dy, minY, maxY)
      }
      // 拖动时每帧最多更新一次状态：直接 setState 会让整个表单重渲染，60fps 下会抖
      pending.current = next
      if (frame.current === null) frame.current = requestAnimationFrame(flush)
    },
    [flush]
  )

  const stop = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!start.current) return
      start.current = null
      setDragging(false)
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current)
        frame.current = null
      }
      pending.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    },
    []
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return
      if ((event.target as HTMLElement).closest(INTERACTIVE)) return
      const modal = modalRef.current
      if (!modal) return
      // 用当前视觉位置反推「没拖动时的位置」，这样连续拖两次也不会累积误差
      const rect = modal.getBoundingClientRect()
      start.current = {
        px: event.clientX,
        py: event.clientY,
        base: offsetRef.current,
        origin: new DOMRect(
          rect.left - offsetRef.current.x,
          rect.top - offsetRef.current.y,
          rect.width,
          rect.height
        )
      }
      setDragging(true)
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
    },
    []
  )

  // 组件卸载时收掉还没执行的帧回调
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    },
    []
  )

  return {
    modalRef,
    handleProps: { onPointerDown, onPointerMove, onPointerUp: stop, onPointerCancel: stop },
    style: { transform: `translate(${offset.x}px, ${offset.y}px)` },
    dragging
  }
}
