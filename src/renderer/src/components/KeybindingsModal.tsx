import { useStore } from '../state/store'
import { Modal } from '../ui/Modal'
import { DIFF_KEYBINDINGS, KEYBINDINGS, formatKeys, type KeyBinding } from '../keybindings'
import '../styles/detail.css'
import '../styles/staging.css'

function Rows({ bindings }: { bindings: KeyBinding[] }) {
  return (
    <>
      {bindings.map((kb) => (
        <tr key={kb.command + kb.keys}>
          <td>{kb.description}</td>
          <td style={{ textAlign: 'right' }}>
            <span className="kbd">{formatKeys(kb.keys)}</span>
          </td>
        </tr>
      ))}
    </>
  )
}

export function KeybindingsModal() {
  const close = () => useStore.getState().setModal(null)
  return (
    <Modal title="Keyboard shortcuts" onClose={close} width={560}>
      <table className="kb-table">
        <tbody>
          <Rows bindings={KEYBINDINGS} />
          <tr>
            <th colSpan={2} className="kb-section">
              In a diff
            </th>
          </tr>
          <Rows bindings={DIFF_KEYBINDINGS} />
        </tbody>
      </table>
    </Modal>
  )
}
