import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { ContextResizeHandle } from './ContextResizeHandle'

function setup(width = 500, max = 700) {
  const onChange = vi.fn()
  renderWithMantine(<ContextResizeHandle width={width} max={max} onChange={onChange} />)
  return { onChange, handle: screen.getByRole('separator', { name: 'Resize ticket details' }) }
}

test('is a vertical separator with its range', () => {
  const { handle } = setup()
  expect(handle).toHaveAttribute('aria-orientation', 'vertical')
  expect(handle).toHaveAttribute('aria-valuenow', '500')
  expect(handle).toHaveAttribute('aria-valuemin', '380')
  expect(handle).toHaveAttribute('aria-valuemax', '700')
  expect(handle).toHaveAttribute('tabindex', '0')
})

test('dragging right widens live and finishes with the final width, clamped at both ends', () => {
  const { handle, onChange } = setup()
  fireEvent.pointerDown(handle, { pointerId: 1, clientX: 500, button: 0 })
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 550 })
  expect(onChange).toHaveBeenLastCalledWith(550, false)
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 2000 })
  expect(onChange).toHaveBeenLastCalledWith(700, false)
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 })
  expect(onChange).toHaveBeenLastCalledWith(380, false)
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: 0 })
  expect(onChange).toHaveBeenLastCalledWith(380, true)
})

test('moving without a press does nothing', () => {
  const { handle, onChange } = setup()
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 10 })
  expect(onChange).not.toHaveBeenCalled()
})

test('double-click and Enter reset to 380', async () => {
  const { handle, onChange } = setup()
  fireEvent.doubleClick(handle)
  expect(onChange).toHaveBeenLastCalledWith(380, true)
  onChange.mockClear()
  handle.focus()
  await userEvent.keyboard('{Enter}')
  expect(onChange).toHaveBeenLastCalledWith(380, true)
})

test('arrows step 16, Shift 64, Home and End go to the limits', async () => {
  const { handle, onChange } = setup()
  handle.focus()
  const press = async (keys: string, expected: number) => {
    onChange.mockClear()
    await userEvent.keyboard(keys)
    expect(onChange).toHaveBeenLastCalledWith(expected, true)
  }
  await press('{ArrowRight}', 516)
  await press('{ArrowLeft}', 484)
  await press('{Shift>}{ArrowRight}{/Shift}', 564)
  await press('{Shift>}{ArrowLeft}{/Shift}', 436)
  await press('{Home}', 380)
  await press('{End}', 700)
})

test('has no axe violations', async () => {
  const { handle } = setup()
  await expectNoAxeViolations(handle.parentElement as HTMLElement)
})
