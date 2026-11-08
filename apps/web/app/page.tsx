import Link from 'next/link';
import { Hero } from './home/hero';
import {
  Site,
  Kicker,
  Icon,
  Arrow,
  Button,
  Path,
  ProductCaption,
} from './home/site';

export const metadata = {
  title: 'Hirearchy — Different work. One clear principle.',
  description:
    'A family of tools for seeing work clearly. Real tasks, visible work and human review. Start with Hirearchy Software.',
};
const processSteps = [
  ['task', 'A real task', 'A practical assignment relevant to the role.'],
  ['work', 'Work in context', 'Candidates show their process and output.'],
  ['record', 'A visible record', 'Work comes together in a clear timeline.'],
  ['person', 'Human review', 'People read, assess and decide.'],
];
const softwareSteps = [
  ['task', 'The task', 'A real, role-relevant assignment.'],
  ['record', 'The work', 'Process and output in context.'],
  ['discussion', 'The discussion', 'People review and ask questions.'],
  ['person', 'The decision', 'Humans decide what comes next.'],
];
export default function HomePage() {
  return (
    <Site home>
      <Hero />
      <section
        id="principle"
        data-chapter="The principle"
        className="ct-process ct-reveal"
        aria-labelledby="process-heading"
      >
        <svg className="ct-paths" viewBox="0 0 751 372" aria-hidden="true">
          <Path d="M268 0Q268 45 314 45H656Q709 45 709 98V314Q709 367 656 367H85" />
        </svg>
        <div className="ct-process-heading ct-enter">
          <Kicker>From tasks to understanding</Kicker>
          <h2 id="process-heading">
            See the work
            <br />
            behind the words.
          </h2>
        </div>
        <ol className="ct-steps">
          {processSteps.map(([icon, title, copy]) => (
            <li className="ct-enter" key={title}>
              <span className="ct-icon">
                <Icon type={icon} />
              </span>
              <h3>{title}</h3>
              <p>{copy}</p>
              <span className="ct-step-arrow">
                <Arrow />
              </span>
            </li>
          ))}
        </ol>
      </section>
      <section
        id="family"
        data-chapter="The family"
        className="ct-family ct-reveal"
        aria-labelledby="family-heading"
      >
        <svg className="ct-paths" viewBox="0 0 751 379" aria-hidden="true">
          <Path d="M85 -5Q42 -5 42 38V208Q42 251 84 251" />
          <Path
            d="M330 250H356Q374 250 374 232Q374 222 397 222"
            color="coral"
            width={12}
            className="ct-family-branch"
          />
          <Path
            d="M330 279H356Q374 279 374 293Q374 302 397 302"
            color="purple"
            width={12}
            className="ct-family-branch"
          />
          <Path
            d="M331 265H554Q574 265 574 285V338Q574 358 600 358H664Q694 358 694 379"
            width={20}
            className="ct-family-continuation"
          />
        </svg>
        <div className="ct-family-heading ct-enter">
          <Kicker>One principle. A wider horizon.</Kicker>
          <h2 id="family-heading">
            A growing family
            <br />
            for a changing world.
          </h2>
        </div>
        <Link
          className="ct-family-software ct-enter"
          href="/products/software"
          prefetch={false}
        >
          <span className="ct-icon">
            <Icon type="software" />
          </span>
          <div>
            <h3>Hirearchy Software</h3>
            <p>First product</p>
            <p className="ct-family-description">
              Turn real work into a clearer
              <br />
              hiring conversation.
            </p>
            <span className="ct-text-link">
              Start with Software <Arrow />
            </span>
          </div>
        </Link>
        <Link
          className="ct-family-future ct-family-it ct-enter"
          href="/products#future"
          prefetch={false}
        >
          <Icon type="it" />
          <span>
            <strong>Hirearchy IT</strong>
            <ProductCaption action="Explore idea">
              Future direction
            </ProductCaption>
          </span>
          <Arrow />
        </Link>
        <Link
          className="ct-family-future ct-family-marketing ct-enter"
          href="/products#future"
          prefetch={false}
        >
          <Icon type="marketing" />
          <span>
            <strong>Hirearchy Marketing</strong>
            <ProductCaption action="Explore idea">
              Future direction
            </ProductCaption>
          </span>
        </Link>
        <aside className="ct-family-aside">
          <Kicker>
            Different work.
            <br />
            Same principle.
          </Kicker>
          <p>
            New tools.
            <br />
            New contexts.
            <br />A clearer view of work,
            <br />
            across every discipline.
          </p>
        </aside>
      </section>
      <section
        id="philosophy"
        data-chapter="Our philosophy"
        className="ct-philosophy ct-reveal"
        aria-labelledby="philosophy-heading"
      >
        <svg className="ct-paths" viewBox="0 0 751 282" aria-hidden="true">
          <Path d="M694 0V240Q694 282 650 282" />
        </svg>
        <div className="ct-enter">
          <Kicker>One philosophy</Kicker>
          <h2 id="philosophy-heading">
            Evidence informs.
            <br />
            <span>People decide.</span>
          </h2>
          <p>
            Work makes the evidence visible.
            <br />
            People bring the judgement, context and care.
            <br />
            The decision stays human.
          </p>
        </div>
      </section>
      <section
        id="software"
        data-chapter="Software"
        className="ct-software ct-reveal"
        aria-labelledby="software-heading"
      >
        <svg className="ct-paths" viewBox="0 0 751 341" aria-hidden="true">
          <Path
            d="M650 0H582Q539 0 539 43V91Q539 129 502 129H400"
            color="deep-mint"
          />
        </svg>
        <div className="ct-software-heading ct-enter">
          <Kicker>The first step</Kicker>
          <h2 id="software-heading">Hirearchy Software</h2>
          <p>Real tasks. Visible work. A clearer conversation.</p>
        </div>
        <ol className="ct-steps ct-software-steps">
          {softwareSteps.map(([icon, title, copy]) => (
            <li className="ct-enter" key={title}>
              <span className="ct-icon">
                <Icon type={icon} />
              </span>
              <h3>{title}</h3>
              <p>{copy}</p>
            </li>
          ))}
        </ol>
        <div
          className="ct-software-button"
          style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}
        >
          <Button href="/early-access">Request early access</Button>
          <Button href="/products/software">Explore Software</Button>
        </div>
        <aside className="ct-software-aside">
          <Kicker>
            Same principle.
            <br />
            More opportunity.
          </Kicker>
          <p>
            A conversation
            <br />
            grounded in the work
            <br />
            people actually do.
          </p>
        </aside>
      </section>
    </Site>
  );
}
