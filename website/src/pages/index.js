import React from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import Translate, {translate} from '@docusaurus/Translate';
import Layout from '@theme/Layout';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import ThemedImage from '@theme/ThemedImage';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './index.module.css';

const tagline = () =>
  translate({
    id: 'home.tagline',
    message: 'Track your portfolio: your events in, your figures out, in one container',
  });

function HomepageHeader() {
  return (
    <header className={clsx('hero', styles.heroBanner)}>
      <div className="container">
        <h1 className="hero__title">SuiviBourse</h1>
        <p className="hero__subtitle">{tagline()}</p>
        <div className={styles.buttons}>
          <Link className="button button--primary button--lg" to="/docs/v5/get-started">
            <Translate id="home.cta.install">Install</Translate>
          </Link>
          <Link className="button button--secondary button--lg" to="/docs/v5/first-steps">
            <Translate id="home.cta.use">First steps</Translate>
          </Link>
        </div>
        <div className={clsx('row', styles.paddingTop)}>
          <ThemedImage
            alt={translate({
              id: 'home.screenshot.alt',
              message:
                'The SuiviBourse dashboard: the portfolio value, its chart against the money paid in, the investment rhythm and the value of each security',
            })}
            sources={{
              light: useBaseUrl('/img/app-dashboard-light.png'),
              dark: useBaseUrl('/img/app-dashboard-dark.png'),
            }}
          />
        </div>
      </div>
    </header>
  );
}

export default function Home() {
  return (
    <Layout title={translate({id: 'home.title', message: 'Track your portfolio'})} description={tagline()}>
      <HomepageHeader />
      <main>
        <HomepageFeatures />
      </main>
    </Layout>
  );
}
