import { AnimatePresence, motion } from 'framer-motion';
import { stateBadge, stateVariant } from '../utils';

export default function DeltaBanner({ changes, onDismiss }) {
  return (
    <AnimatePresence>
      {changes.length > 0 && (
        <motion.div
          className="delta-banner"
          initial={{ opacity: 0, y: -12, scaleY: 0.9 }}
          animate={{ opacity: 1, y: 0, scaleY: 1 }}
          exit={{ opacity: 0, y: -12, scaleY: 0.9 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
        >
          <div className="delta-header">
            <svg className="delta-flash" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M13 2L4.5 13.5H11L10 22L19.5 10.5H13L13 2Z"/>
            </svg>
            <span className="delta-title">
              {changes.length} site{changes.length !== 1 ? 's' : ''} changed since last refresh
            </span>
            <button className="delta-dismiss" onClick={onDismiss}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
              </svg>
            </button>
          </div>
          <div className="delta-rows">
            {changes.map((c, i) => (
              <motion.div
                key={c.hostname}
                className="delta-row"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.04, duration: 0.18 }}
              >
                <span className="delta-host">{c.hostname}</span>
                <span className={`delta-badge delta-badge--${stateVariant(c.from)}`}>
                  {stateBadge(c.from)}
                </span>
                <svg width="14" height="10" viewBox="0 0 14 10" fill="none" className="delta-arrow">
                  <path d="M0 5h12M8 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <span className={`delta-badge delta-badge--${stateVariant(c.to)}`}>
                  {stateBadge(c.to)}
                </span>
              </motion.div>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
