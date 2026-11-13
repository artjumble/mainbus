import { Button, Center, Modal, Stack, Text, Title } from '@mantine/core'
import { useState, type ReactElement } from 'react'
import { addBaseQuestion } from '../../../shared/baseBranch'
import type { FolderReadiness } from '../../../shared/api'
import { invoke, openFolder } from '../api'
import { showError } from '../notify'
import { useMainbus } from '../store'
import { BaseBranchStep } from './BaseBranchStep'
import { GitSetup } from './GitSetup'

/** Shown when Claude Code is ready but no repo is open yet. */
export function OpenWorkspace(): ReactElement {
  const openWorkspace = useMainbus((s) => s.openWorkspace)
  const [opening, setOpening] = useState(false)
  const [notReady, setNotReady] = useState<FolderReadiness | null>(null)
  const [askBase, setAskBase] = useState<FolderReadiness | null>(null)

  async function pick(): Promise<void> {
    setOpening(true)
    try {
      const folder = await openFolder()
      if (folder) {
        const readiness = await invoke('workspace.check', folder)
        if (readiness.status !== 'ready') setNotReady(readiness)
        else if (readiness.base && addBaseQuestion(readiness.base) !== 'none') setAskBase(readiness)
        else await openWorkspace(folder)
      }
    } catch (err) {
      showError(err, 'Could not open that folder')
    } finally {
      setOpening(false)
    }
  }

  return (
    <Center mih="100vh" p="md">
      <Stack maw={520} gap="md">
        <Title order={2}>Welcome to Mainbus</Title>
        <Text>
          Mainbus runs Claude Code agents on your tickets, each in its own folder, and asks you only when it needs a
          decision. Add the project folder you want to work on to begin. A git repository works as it is; any other
          folder, Mainbus can set up.
        </Text>
        <Text size="sm" c="dimmed">
          Claude Code can't ask you to trust a folder while Mainbus runs it, so Mainbus treats the folder you pick as
          trusted.
        </Text>
        <Button onClick={() => void pick()} loading={opening} w="fit-content" aria-label="Add workspace">
          + Add workspace
        </Button>
      </Stack>
      <Modal opened={notReady !== null} onClose={() => setNotReady(null)} title="Add workspace">
        {notReady && <GitSetup readiness={notReady} onDone={() => setNotReady(null)} onCancel={() => setNotReady(null)} />}
      </Modal>
      <Modal opened={askBase !== null} onClose={() => setAskBase(null)} title="Add workspace">
        {askBase?.base && (
          <BaseBranchStep folder={askBase.folder} choice={askBase.base} onDone={() => setAskBase(null)} onCancel={() => setAskBase(null)} />
        )}
      </Modal>
    </Center>
  )
}
