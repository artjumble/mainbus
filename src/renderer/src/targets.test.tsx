import { ActionIcon, Button, Modal } from '@mantine/core'
import { screen } from '@testing-library/react'
import targets from './targets.module.css'
import { renderWithMantine } from './test-utils'

// jsdom lays nothing out and vitest loads no CSS, so the scroll and the 44 px hit area are measured in
// e2e/loadingButtons.spec.ts; this checks the theme puts the classes of targets.module.css where its rules expect them.

test('a loading Button in a Modal keeps its 44 px hit area, and its label only fades, without sliding out of the dialog', () => {
  renderWithMantine(
    <Modal opened onClose={() => {}} title="Add workspace">
      <Button loading>Choose folder…</Button>
    </Modal>
  )
  expect(targets.target).toBeTruthy()
  expect(targets.loadingContent).toBeTruthy()
  const button = screen.getByRole('button', { name: 'Choose folder…' })
  expect(button).toHaveAttribute('data-loading')
  expect(button).toHaveClass(targets.target)
  // The label's box is what Mantine slides down while loading; the theme marks it so the slide is undone.
  expect(button.querySelector('.mantine-Button-inner')).toHaveClass(targets.loadingContent)
})

test('a loading ActionIcon gets the same', () => {
  renderWithMantine(
    <ActionIcon loading aria-label="Refresh">
      <span aria-hidden>↻</span>
    </ActionIcon>
  )
  const icon = screen.getByRole('button', { name: 'Refresh' })
  expect(icon).toHaveClass(targets.target)
  expect(icon.querySelector('.mantine-ActionIcon-icon')).toHaveClass(targets.loadingContent)
})
