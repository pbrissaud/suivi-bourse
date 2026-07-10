import React from 'react';
import clsx from 'clsx';
import styles from './styles.module.css';

const FeatureList = [
  {
    title: 'Two ways to configure',
    description: (
      <>
        Describe your portfolio in a simple YAML file, or import your broker
        transactions from CSV/XLSX files and let Suivi Bourse aggregate them.
      </>
    ),
  },
  {
    title: 'Live prices & full history',
    description: (
      <>
        Fetch live quotes from Yahoo! Finance and backfill historical prices into
        InfluxDB 3, then visualize everything in a ready-made Grafana dashboard.
      </>
    ),
  },
  {
    title: 'Deploy everywhere',
    description: (
      <>
        Run it as a system service, a Docker container or a full Docker Compose
        stack on Linux, macOS and Windows.
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
