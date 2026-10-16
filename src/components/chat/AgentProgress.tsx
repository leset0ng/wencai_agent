import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { LoaderCircle } from 'lucide-react'
import { AgentAvatar } from '#/components/banking/AgentAvatar'
import { bankEase } from '#/components/ui/motion'
import type { AgentStage } from './progress'
import './agent-progress.css'

/** Shared stage card for any banking workflow; changing stage.key rolls the text upward. */
export function AgentProgress({ stage }: { stage: AgentStage }) {
  const reduce = useReducedMotion()
  return <motion.div className="bank-agent-progress" data-motion="agent-progress" initial={{opacity:0,y:reduce?0:14}} animate={{opacity:1,y:0}} exit={{opacity:0,y:reduce?0:-12}} transition={{duration:reduce?0:.25,ease:bankEase}}>
    <AgentAvatar small />
    <div className="bank-agent-progress-body">
      <div className="bank-agent-progress-caption" aria-hidden="true"><i />思考中…</div>
      <div className="bank-agent-progress-card" role="status" aria-live="polite" aria-atomic="true">
        <LoaderCircle className="bank-agent-progress-spinner" size={32} aria-hidden="true" />
        <div className="bank-agent-stage-viewport">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.div key={stage.key} className="bank-agent-stage-text" data-stage={stage.key}
              initial={{opacity:reduce?1:0,y:reduce?0:54}} animate={{opacity:1,y:0}} exit={{opacity:0,y:reduce?0:-54}}
              transition={{duration:reduce?0:.36,ease:bankEase}}>
              <strong>{stage.title}</strong><p>{stage.description}</p>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  </motion.div>
}
