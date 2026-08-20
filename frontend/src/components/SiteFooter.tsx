import { GitHubIcon, LinkedInIcon } from './Icon';

/**
 * Who built this, on every page.
 *
 * A public demo with no author on it is an orphan - somebody lands on the
 * Kafka control room from a CV link and has nowhere to go next. This sits
 * under the content rather than in the header, so it is findable without
 * competing with the navigation.
 */
const AUTHOR = {
  name: 'Hemant Saini',
  role: 'Software Engineer',
  github: 'https://github.com/hemxnt-saini',
  linkedin: 'https://www.linkedin.com/in/hemxntsaini',
};

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-who">
          <span className="site-footer-label">Engineered by</span>
          <span className="site-footer-name">{AUTHOR.name}</span>
          <span className="tiny muted">{AUTHOR.role}</span>
        </div>

        <div className="site-footer-links">
          <a
            className="site-footer-link"
            href={AUTHOR.github}
            target="_blank"
            // noreferrer as well as noopener: the target page has no business
            // knowing which of these pages someone came from.
            rel="noopener noreferrer"
          >
            <GitHubIcon />
            GitHub
          </a>
          <a
            className="site-footer-link"
            href={AUTHOR.linkedin}
            target="_blank"
            rel="noopener noreferrer"
          >
            <LinkedInIcon />
            LinkedIn
          </a>
        </div>
      </div>
    </footer>
  );
}
