import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { PanelResizeHandle } from './PanelResizeHandle'

function setup(width = 400, max = 640) {
  const onChange = vi.fn()
  renderWithMantine(<PanelResizeHandle width={width} max={max} onChange={onChange} />)
  return { onChange, handle: screen.getByRole('separator', { name: 'Resize orchestrator panel' }) }
}

test('is a vertical separator with its range', () => {
  const { handle } = setup()
  expect(handle).toHaveAttribute('aria-orientation', 'vertical')
  expect(handle).toHaveAttribute('aria-valuenow', '400')
  expect(handle).toHaveAttribute('aria-valuemin', '280')
  expect(handle).toHaveAttribute('aria-valuemax', '640')
  expect(handle).toHaveAttribute('tabindex', '0')
})

test('dragging left widens live and finishes with the final width, clamped at both ends', () => {
  const { handle, onChange } = setup()
  fireEvent.pointerDown(handle, { pointerId: 1, clientX: 1000, button: 0 })
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 950 })
  expect(onChange).toHaveBeenLastCalledWith(450, false)
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 })
  expect(onChange).toHaveBeenLastCalledWith(640, false)
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 2000 })
  expect(onChange).toHaveBeenLastCalledWith(280, false)
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: 2000 })
  expect(onChange).toHaveBeenLastCalledWith(280, true)
})

test('moving without a press does nothing', () => {
  const { handle, onChange } = setup()
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 10 })
  expect(onChange).not.toHaveBeenCalled()
})

test('double-click and Enter reset to 340', async () => {
  const { handle, onChange } = setup(500)
  fireEvent.doubleClick(handle)
  expect(onChange).toHaveBeenLastCalledWith(340, true)
  onChange.mockClear()
  handle.focus()
  await userEvent.keyboard('{Enter}')
  expect(onChange).toHaveBeenLastCalledWith(340, true)
})

test('arrows step 16, Shift 64, Home and End go to the limits', async () => {
  const { handle, onChange } = setup()
  handle.focus()
  const press = async (keys: string, expected: number) => {
    onChange.mockClear()
    await userEvent.keyboard(keys)
    expect(onChange).toHaveBeenLastCalledWith(expected, true)
  }
  await press('{ArrowLeft}', 416)
  await press('{ArrowRight}', 384)
  await press('{Shift>}{ArrowLeft}{/Shift}', 464)
  await press('{Shift>}{ArrowRight}{/Shift}', 336)
  await press('{Home}', 280)
  await press('{End}', 640)
})

test('has no axe violations', async () => {
  const { handle } = setup()
  await expectNoAxeViolations(handle.parentElement as HTMLElement)
})
