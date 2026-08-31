import React from 'react';
import clsx from 'clsx';
import styles from './styles.module.css';

// Three sentences about the product, and not one about an assembly: v5 is one
// container with one embedded store, so "two ways to configure", "a ready-made
// Grafana dashboard" and "a full Docker Compose stack" all lost their subject
// (ADR-0012, ADR-0014, ADR-0015).
const FeatureList = [
  {
    title: 'Your events are the truth',
    description: (
      <>
        Record what you bought, sold, received and paid in — in the app, or from
        the files your broker exports. Everything else is derived from them, and
        can be recomputed at any time.
      </>
    ),
  },
  {
    title: 'Prices, and the past behind them',
    description: (
      <>
        Live quotes on a cadence that follows each market, history rebuilt back
        to your first purchase, and every figure reported in one currency you
        choose once.
      </>
    ),
  },
  {
    title: 'One container, or none at all',
    description: (
      <>
        A single image with its own store and its own interface — four pages,
        one port, nothing to compose. Or the same app installed with uv, on a
        machine that runs no container at all.
      </>
    ),
  },
];

function Feature({title, description}) {
  return (
    <div className={clsx('col col--4')}>
      <div className="text--center padding-horiz--md">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures() {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
