import React from 'react';
import { useApp } from '../context.js';

const TOOLS = [
  ['Connections', '/connections', '⚙', 'Configure AWS profiles, credentials and custom endpoints.'],
  ['Operation builder', '/ops', '⤢', 'Build DynamoDB operations and generate code for your SDK.'],
  ['PartiQL editor', '/partiql', '⌨', 'Run DynamoDB statements, batches and transactions.'],
  ['Data modeler', '/modeler', '▦', 'Design tables, indexes and access patterns.'],
  ['S3 browser', '/s3', '▱', 'Browse, preview and transfer objects and folders.'],
  ['Secrets Manager', '/secrets', '', 'Manage secrets and retrieve versioned values.'],
];

export default function Home() {
  const { conn, tables, info } = useApp();
  return (
    <div className="page home-page">
      <div className="home-overview">
        <div className="home-intro">
          <h1>AWS Tool Web</h1>
          <p>Explore and manage AWS resources from one console.</p>
        </div>
        {conn ? (
          <div className="home-context">
            <h3>Connected: {info.label}</h3>
            <p>{info.endpoint ? `Endpoint ${info.endpoint}` : `Region ${info.region}`} · {tables.length} tables</p>
            <a href="#/connections">Manage connections <span aria-hidden="true">→</span></a>
          </div>
        ) : (
          <div className="home-context">
            <h3>Get started</h3>
            <p>Add an AWS profile or a local endpoint, then select it in the connection picker.</p>
            <a href="#/connections">Open Connections <span aria-hidden="true">→</span></a>
          </div>
        )}
      </div>
      <section aria-labelledby="tools-title">
        <h2 className="home-tools-title" id="tools-title">Workspace tools</h2>
        <div className="feature-grid home-tools">
          {TOOLS.map(([title, path, glyph, description]) => (
            <a className="card feature tool-card" href={`#${path}`} key={path}>
              <span className="feature-icon" aria-hidden="true">{glyph || <span className="lock-glyph" />}</span>
              <span className="tool-card-copy"><strong>{title}</strong><span>{description}</span></span>
              <span className="tool-card-arrow" aria-hidden="true">→</span>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
