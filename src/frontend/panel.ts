import * as React from 'react'
import type { ReactNode, ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { PanelProps } from './client-types.js'
import { categories, counts, detailView, formatTokens, recoveryUsageView } from './display.js'
import { css } from './styles.js'
import { usePromptFreezePanel } from './use-panel.js'

const { createElement: h } = React

export function PromptFreezePanel(props: PanelProps): ReactElement {
  const {
    t, state, open, working, review, selected, preview, setPreview, settings,
    recoveryUI, recovery, recoveryError, toast, toastNode, toastPosition,
    pauseToast, resumeToast, close, focusClose, panelId, trigger,
    dismissRecovery, answerRecovery, copyDeferred, shown, stale, changed,
    liveMismatch, settingsError, showAutoInfo, triggerWarning, healthy,
    triggerDescription, childRecoveryNote, disabled, refreshReview, short,
    notification, deltas, hasLiveChanges, acknowledgeVisible, acknowledge,
    selectCategory, updateThreshold, saveThreshold, applySnapshot, togglePanel,
  } = usePromptFreezePanel(props)
  const dialog = open && !recoveryUI.open && h('div', { className: 'pf-root pf-backdrop', onClick: event => { if (event.target === event.currentTarget) close() }, onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); close() }
    if (event.key === 'Tab') {
      const nodes = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]')].filter(node => node.getClientRects().length)
      const first = nodes[0], last = nodes[nodes.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    } } },
    h('style', null, css),
    h('section', { role: 'dialog', 'aria-modal': true, 'aria-label': 'Prompt Freeze', className: 'pf-dialog' },
      h('header', { className: 'pf-header' }, h('div', { className: 'pf-heading' }, h('h3', null, 'Prompt Freeze'), h('button', { onClick: close, ref: focusClose }, t('close'))),
      h('div', { className: 'pf-meta' },
        h('p', null, t('revisions', { active: short(shown?.active?.revision), candidate: short(shown?.candidate?.revision) })),
        h('p', null, t('status', { status: working ? t('working') : state?.busy ? t('busy') : t('idle'), notice: notification[state?.noticeState ?? ''] ?? t('loading') })))),
      h('div', { className: 'pf-scroll' }, h('div', { className: 'pf-status' },
              triggerWarning && h('section', { role: 'status', 'aria-live': 'polite', 'aria-atomic': true, 'aria-label': t('liveStatus'), className: `pf-live-status ${showAutoInfo ? 'pf-info' : 'pf-warning'}` },
          h('h4', null, t('liveStatus')), h('p', null, triggerWarning)),
        review && (stale || liveMismatch) && h('p', { className: 'pf-note pf-pinned-help' }, t('pinnedReviewHelp')),
        childRecoveryNote && h('p', { className: 'pf-note' }, childRecoveryNote),
        h('section', { 'aria-label': t('settingsTitle') },
          h('div', { className: 'pf-threshold-row' },
            h('label', { htmlFor: `${panelId}-threshold` }, t('settingsThreshold')),
            h('input', { id: `${panelId}-threshold`, type: 'text', value: settings.draft, disabled: settings.pending || settings.baseRevision === null, 'aria-label': t('settingsThreshold'), 'aria-describedby': `${panelId}-threshold-hint`, onBlur: () => saveThreshold(), onKeyDown: event => { if (event.key === 'Enter' && !event.nativeEvent?.isComposing && !(event as React.KeyboardEvent<HTMLInputElement> & { isComposing?: boolean }).isComposing) { event.preventDefault(); return saveThreshold() } }, onChange: event => updateThreshold(event.target.value) }),
            h('span', { id: `${panelId}-threshold-hint`, className: 'pf-threshold-hint' }, t('settingsHint'))),
         settings.conflict && h('p', { role: 'alert' }, t('settingsConflict')),
         settingsError && h('p', { role: 'alert' }, t('settingsError', { error: settingsError })),
         settings.pending && h('p', { role: 'status' }, t('settingsSaving')),
         settings.result && h('p', { role: 'status' }, t('settingsSaved'))),
       state?.awaitingFirstCall && h('p', null, t('firstCall')),
      state?.upgradeRequired && h('p', { role: 'status' }, t('upgrade')),
      state?.baselineRequired && h('p', null, t('repair')),
      stale && h('p', { role: 'alert' }, t('stale'))
      ), !review ? h('p', { role: 'status', className: 'pf-status' }, working ? t('loadingReview') : t('missingReview')) : h('div', { className: 'pf-body' },
        h('nav', { className: 'pf-nav', 'aria-label': t('categories') }, ...categories.map(unit => h('button', { type: 'button', key: unit, 'aria-expanded': selected === unit, 'aria-controls': panelId, onClick: () => selectCategory(unit) }, h('strong', null, t(unit), ' ›'), h('span', { className: 'pf-counts' }, counts(deltas![unit], t)), hasLiveChanges(unit) && h('span', { className: 'pf-badge pf-live', title: t('liveCacheHelp') }, t('live')), deltas![unit].partial && h('span', { className: 'pf-badge' }, deltas![unit].available ? t('partial') : t('missingBaseline'))))),
        h('section', { id: panelId, className: 'pf-detail', 'aria-label': t('details', { category: t(selected) }), tabIndex: 0, key: selected },
          h('h4', null, t(selected)), h('p', { className: 'pf-note' }, selected === 'contexts' || selected === 'variables' ? t('liveHelp') : selected === 'sections' ? t('sectionHelp') : t('toolHelp')),
          detailView(selected, deltas![selected], preview, setPreview, panelId, t),
          selected === 'tools' && shown?.diff && h('p', { className: 'pf-note' }, t('sdkChanges', { sdk: shown.diff.sdkChanged ? t('yes') : t('no'), mode: shown.diff.modeChanged ? t('yes') : t('no') })))),
      h('p', { className: 'pf-note', style: { padding: '0 18px' } }, t('observationHelp')),
            h('details', { className: 'pf-note', style: { padding: '0 18px 12px' } }, h('summary', null, t('scope')), h('p', null, t('scopeHelp')))
      ),
      h('footer', { className: 'pf-footer' }, h('div', { className: 'pf-actions' },
        h('button', { type: 'button', className: 'pf-review', disabled: working, onClick: refreshReview }, t('review')),
        acknowledgeVisible && h('button', { type: 'button', disabled, title: t('acknowledgeHelp'), 'aria-label': t('acknowledge'), onClick: () => void acknowledge() }, t('acknowledge')),
        h('button', { className: 'pf-primary', disabled: disabled || !changed && !state?.baselineRequired, onClick: applySnapshot }, state?.baselineRequired ? t('establish') : state?.upgradeRequired ? t('applyUpgrade') : t('apply'))
      ))))
  const recoveryDialog = recoveryUI.open && recovery && ['awaiting-choice', 'pending'].includes(recovery.phase) && h('div', {
    className: 'pf-root pf-backdrop', onClick: event => { if (event.target === event.currentTarget) dismissRecovery() },
    onKeyDown: event => {
      if (event.key === 'Escape') { event.stopPropagation(); dismissRecovery() }
      if (event.key === 'Tab') {
        const nodes = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)')], first = nodes[0], last = nodes[nodes.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
  }, h('style', null, css), h('section', { role: 'dialog', 'aria-modal': true, 'aria-label': t('recoveryTitle'), className: 'pf-dialog pf-recovery' },
    h('header', { className: 'pf-header pf-heading' }, h('h3', null, t('recoveryTitle')), h('button', { onClick: dismissRecovery, ref: focusClose }, t('close'))),
    h('div', { className: 'pf-scroll pf-status' }, h('p', null, t('recoveryQuestion')), h('p', null, t('recoveryChoiceHelp')),
      recovery.frozenContentMatches === true && h('p', { className: 'pf-note' }, t('recoveryUnchangedHelp')),
      recovery.frozenContentMatches === false && h('p', { className: 'pf-note' }, t('recoveryChangedHelp')),
      typeof recovery.estimatedContextInputTokens === 'number' && Number.isSafeInteger(recovery.estimatedContextInputTokens) && recovery.estimatedContextInputTokens >= 0 && h('p', { className: 'pf-recovery-estimate', title: t('recoveryEstimateHelp') }, t('recoveryEstimate', { tokens: formatTokens(recovery.estimatedContextInputTokens) })),
      h('p', { className: 'pf-warning' }, t('recoveryDismissHelp')), recoveryError && h('p', { role: 'alert' }, recoveryError),
      recovery.deferredMessage?.text && h('div', { className: 'pf-note' }, h('p', null, t('recoveryDeferred')), h('button', { type: 'button', onClick: () => copyDeferred(recovery.deferredMessage!.text!) }, t('recoveryCopy'))),
      recoveryUI.pending && h('p', { role: 'status' }, t('recoveryAnswering')),
      recovery.phase === 'pending' && h('p', { role: 'status' }, t('recoveryPending'))),
    h('footer', { className: 'pf-footer pf-actions' },
      h('button', { disabled: recoveryUI.pending || !['pending', 'awaiting-choice'].includes(recovery.phase), onClick: () => answerRecovery('keep') }, t('recoveryKeep')),
      h('button', { disabled: recoveryUI.pending || !['pending', 'awaiting-choice'].includes(recovery.phase), onClick: () => answerRecovery('recapture') }, t('recoveryRecapture')))))
  const toastView = toast && h('div', { className: 'pf-toast', ref: toastNode, style: toastPosition, role: 'status', 'aria-live': 'polite', 'aria-atomic': true, onMouseEnter: pauseToast, onMouseLeave: resumeToast }, t(`recoveryOutcome-${toast.kind}`), recoveryUsageView(toast, t))
  const portal = (node: ReactNode): ReactNode => node && (typeof document !== 'undefined' ? createPortal(node, document.body) : node)
  return h('span', { className: 'pf-root' }, h('style', null, css),
    h('button', { className: 'pf-trigger', ref: trigger, type: 'button', onClick: togglePanel, 'aria-expanded': open || recoveryUI.open, 'aria-label': triggerDescription, title: triggerDescription }, 'Prompt Freeze',
      showAutoInfo ? h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': true, focusable: false },
        h('circle', { cx: 12, cy: 12, r: 10, fill: 'none', stroke: '#3b82f6', strokeWidth: 2 }),
        h('path', { d: 'M11 10h2v8h-2zM11 6h2v2h-2z', fill: '#3b82f6' })) : triggerWarning ? h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', style: { marginLeft: 4, verticalAlign: 'middle' }, 'aria-hidden': true, focusable: false },
        h('path', { d: 'M12 2 23 22H1Z', fill: '#000' }),
        h('path', { d: 'M11 8h2v7h-2zM11 17h2v2h-2z', fill: '#fff' })) : healthy && h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': true, focusable: false },
        h('path', { d: 'M5 12l4 4L19 6', fill: 'none', stroke: '#22c55e', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }))),
    portal(dialog), portal(recoveryDialog), portal(toastView))
}
