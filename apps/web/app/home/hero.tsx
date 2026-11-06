import Link from 'next/link';
import { Arrow, Icon, Path, ProductCaption } from './site';
export function Hero() {
  return (
    <section
      id="introduction"
      data-chapter="Introduction"
      className="ct-hero ct-reveal"
      aria-labelledby="hero-heading"
    >
      <div className="ct-hero-copy ct-enter">
        <h1 id="hero-heading">
          Different work.
          <br />
          One clear principle.
        </h1>
        <p>A family of tools for seeing work clearly.</p>
      </div>
      <svg
        className="ct-paths"
        viewBox="0 0 751 538"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <Path d="M213 346H242Q268 346 268 320V538" className="ct-main-thread" />
        <Path d="M267 346H517" color="coral" className="ct-branch-two" />
        <Path
          d="M248 346Q268 346 268 366Q268 381 289 381H364Q399 381 399 402Q399 421 419 421H518"
          color="purple"
          className="ct-branch-three"
        />
        <Path
          d="M213 346H242Q268 346 268 324Q268 309 289 309H386Q410 309 410 285Q410 264 434 264H497"
          className="ct-branch-one"
        />
      </svg>
      <p className="ct-hero-brand">Hirearchy</p>
      <p className="ct-hero-principle">
        Real tasks.
        <br />
        Visible work.
        <br />
        Human review.
        <span />
      </p>
      <Link
        className="ct-destination ct-destination--software"
        href="/products/software"
        prefetch={false}
      >
        <Icon type="software" />
        <span>
          <strong>Hirearchy Software</strong>
          <ProductCaption action="Explore Software">
            Internal demo
          </ProductCaption>
        </span>
        <Arrow />
      </Link>
      <Link
        className="ct-destination ct-destination--it"
        href="/products#future"
        prefetch={false}
      >
        <Icon type="it" />
        <span>
          <strong>Hirearchy IT</strong>
          <ProductCaption action="Explore the idea">
            Future direction
          </ProductCaption>
        </span>
        <Arrow />
      </Link>
      <Link
        className="ct-destination ct-destination--marketing"
        href="/products#future"
        prefetch={false}
      >
        <Icon type="marketing" />
        <span>
          <strong>Hirearchy Marketing</strong>
          <ProductCaption action="Explore the idea">
            Future direction
          </ProductCaption>
        </span>
        <Arrow />
      </Link>
      <a className="ct-scroll-cue" href="#principle">
        <span>Follow the thread</span>
        <Arrow />
      </a>
      <p className="ct-hero-note">
        Same principle.
        <br />
        Different disciplines.
        <span />
      </p>
    </section>
  );
}
