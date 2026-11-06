import { Site, Kicker, Button, ContactCta } from '../../home/site';
export const metadata = {
  title: 'Hirearchy Software',
  description:
    'Internal demo in development for role-relevant engineering work, saved revisions and human review. AI assistance and code execution are unavailable.',
};
export default function SoftwarePage() {
  return (
    <Site dark>
      <section className="ct-page-hero ct-page-hero--dark ct-reveal">
        <Kicker>Hirearchy Software / Internal demo in development</Kicker>
        <h1 className="ct-enter">
          See engineering
          <br />
          work in context.
        </h1>
        <p>
          The intended demo has candidates work on a role-relevant engineering
          task, save workspace revisions and submit for assigned evaluator
          review. AI assistance and code execution are unavailable.
        </p>
        <Button href="#demo-limits" light>
          See demo limits
        </Button>
      </section>
      <section className="ct-editorial ct-editorial--lilac ct-reveal">
        <h2 className="ct-enter">The work. The record.</h2>
        <div className="ct-record-grid">
          <article className="ct-record ct-enter">
            <Kicker>Illustrative task</Kicker>
            <h3>Make a focused engineering change.</h3>
            <p>
              Read the task and starter workspace, make and save a revision,
              then submit the work. The assigned evaluator reviews the saved
              record.
            </p>
          </article>
          <article className="ct-record ct-enter">
            <Kicker>Intended demo record</Kicker>
            <ol>
              <li>Workspace revision saved</li>
              <li>Candidate submission recorded</li>
              <li>Evaluator observation linked to its source</li>
            </ol>
          </article>
        </div>
      </section>
      <section className="ct-editorial ct-reveal">
        <h2 className="ct-enter">
          Evidence informs.
          <br />
          People decide.
        </h2>
        <ol className="ct-principles">
          <li className="ct-enter">
            <span>01</span>
            <h3>A chronological view.</h3>
            <p>
              Follow recorded work in order, with the surrounding task context.
            </p>
          </li>
          <li className="ct-enter">
            <span>02</span>
            <h3>Inspectable sources.</h3>
            <p>
              Review saved revisions and submitted work. Keep human observations
              connected to the evidence they describe.
            </p>
          </li>
          <li className="ct-enter">
            <span>03</span>
            <h3>Visible uncertainty.</h3>
            <p>
              Capture gaps and limitations remain visible. A record of work is
              evidence for a conversation, not an automatic verdict.
            </p>
          </li>
        </ol>
      </section>
      <section
        className="ct-editorial ct-editorial--lilac ct-reveal"
        id="demo-limits"
      >
        <h2 className="ct-enter">What this internal demo supports</h2>
        <p className="ct-enter">
          The internal demo does not provide integrated AI assistance or run
          candidate code. It is being prepared to record saved workspace
          revisions and submissions for human review; it will not infer whether
          code came from AI or any other source. Customer access is not open
          yet.
        </p>
      </section>
      <ContactCta title="Customer access is not open yet." />
    </Site>
  );
}
