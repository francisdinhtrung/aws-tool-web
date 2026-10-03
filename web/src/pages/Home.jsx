import React from 'react';
import { useApp } from '../context.js';

export default function Home() {
  const { conn, tables, info } = useApp();
  return (
    <div className="page">
      <div className="hero">
        <h1>DynamoDB Studio</h1>
        <p className="muted">A self-hosted, browser-based replacement for NoSQL Workbench: manage AWS profiles, explore and edit data, build operations, run PartiQL and design data models.</p>
      </div>
      {!conn ? (
        <div className="card">
          <h3>Get started</h3>
          <ol className="steps">
            <li>Open <a href="#/connections">Connections</a> to add or edit an AWS profile (written to <code>~/.aws</code>), or add a DynamoDB Local endpoint.</li>
            <li>Pick the connection in the top bar and choose a region.</li>
            <li>Browse tables on the left, or use the Operation builder, PartiQL editor, Data modeler and S3 browser.</li>
          </ol>
        </div>
      ) : (
        <div className="card">
          <h3>Connected: {info.label}</h3>
          <p className="muted">
            {info.endpoint ? `Endpoint ${info.endpoint}` : `Region ${info.region}`} · {tables.length} tables
          </p>
        </div>
      )}
      <div className="feature-grid">
        <a className="card feature" href="#/connections"><h4>⚙ Connections</h4><p>Create, edit and delete AWS profiles (keys, SSO, assume-role) and custom endpoints.</p></a>
        <a className="card feature" href="#/ops"><h4>⚡ Operation builder</h4><p>Get/Put/Update/Delete, Query/Scan, batch and transactions, with Python, JavaScript and CLI code.</p></a>
        <a className="card feature" href="#/partiql"><h4>⌨ PartiQL editor</h4><p>Run SQL-compatible statements and transactions with history.</p></a>
        <a className="card feature" href="#/s3"><h4>🪣 S3 browser</h4><p>Browse buckets like a file manager: upload (drag & drop, folders), download, preview, copy/move/rename, share links, versions, tags and bucket settings.</p></a>
        <a className="card feature" href="#/modeler"><h4>▦ Data modeler</h4><p>Design tables, GSIs and facets, visualize access patterns, import/export Workbench models, commit to DynamoDB, export CloudFormation.</p></a>
      </div>
    </div>
  );
}
