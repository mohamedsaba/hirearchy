import {
  EvaluatorWorkbenchSkeleton,
  SkeletonBlock,
} from '../_components/skeleton';
import '../evaluator/sessions/[sessionId]/desktop-review.css';

export default function DemoLoading() {
  return (
    <EvaluatorWorkbenchSkeleton
      banner={
        <header
          className="software-product-header demo-sticky-topbar"
          aria-hidden="true"
        >
          <div className="demo-topbar-brand">
            <span className="software-wordmark">
              <span>Hirearchy</span>
              <span className="software-product-capsule">Software</span>
            </span>
            <SkeletonBlock width="14rem" height="1.5rem" radius="999px" />
          </div>
          <div className="software-header-controls demo-topbar-actions">
            <SkeletonBlock
              width="2rem"
              height="2rem"
              radius="999px"
              index={1}
            />
            <SkeletonBlock
              width="9.5rem"
              height="2rem"
              radius="8px"
              tone="accent"
              index={2}
            />
          </div>
        </header>
      }
    />
  );
}
