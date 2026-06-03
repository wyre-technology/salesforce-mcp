/**
 * Tool definitions + dispatch for the salesforce-mcp sidecar.
 *
 * Scope discipline: 6 read/write CRM tools only. Apex code management,
 * custom-object creation, EXECUTE_ANONYMOUS, and debug-log management
 * are deliberately OUT OF SCOPE for v1 — they're org-modify / code-execute
 * surfaces inappropriate for the gateway's BYOC CRM-data use case.
 *
 * Tool names use the `salesforce_` prefix (matches tsmztech and other
 * Salesforce MCP servers) so customers' tool-allowlist memory keeps working
 * if they ever migrate from another implementation.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Connection } from 'jsforce';

export const SALESFORCE_TOOLS: Tool[] = [
  {
    name: 'salesforce_search_objects',
    description:
      'Search Salesforce objects by partial name. Returns matching standard and custom objects. Use this to discover which objects to query before describing or querying them. Example: "Account" returns Account, AccountHistory, AccountContactRelation, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Partial object name to search for. Case-insensitive.',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'salesforce_describe_object',
    description:
      'Get the full schema for a Salesforce object — all fields with types, labels, picklist values, and relationships. Use before constructing queries to know exact field names.',
    inputSchema: {
      type: 'object',
      properties: {
        objectName: {
          type: 'string',
          description: 'API name of the Salesforce object (e.g. "Account", "Opportunity", "Custom_Object__c").',
        },
      },
      required: ['objectName'],
    },
  },
  {
    name: 'salesforce_query_records',
    description:
      'Execute a SOQL query against Salesforce. Supports parent-to-child and child-to-parent relationship queries. For aggregate queries (GROUP BY, COUNT, SUM), use salesforce_aggregate_query instead.',
    inputSchema: {
      type: 'object',
      properties: {
        soql: {
          type: 'string',
          description: 'A SOQL SELECT statement. Example: "SELECT Id, Name, Industry FROM Account WHERE Industry = \'Technology\' LIMIT 100"',
        },
      },
      required: ['soql'],
    },
  },
  {
    name: 'salesforce_aggregate_query',
    description:
      'Execute a SOQL aggregate query (GROUP BY, COUNT, SUM, AVG, MIN, MAX, COUNT_DISTINCT). Use for reporting / rollups. HAVING clauses supported.',
    inputSchema: {
      type: 'object',
      properties: {
        soql: {
          type: 'string',
          description: 'A SOQL aggregate query. Example: "SELECT StageName, COUNT(Id) FROM Opportunity GROUP BY StageName"',
        },
      },
      required: ['soql'],
    },
  },
  {
    name: 'salesforce_dml_records',
    description:
      'Perform record-level data operations: insert, update, delete, or upsert. Operates on one object type per call; pass an array of records.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['insert', 'update', 'delete', 'upsert'],
          description: 'The DML operation to perform.',
        },
        objectName: {
          type: 'string',
          description: 'API name of the Salesforce object to operate on (e.g. "Account", "Contact").',
        },
        records: {
          type: 'array',
          items: { type: 'object' },
          description:
            'Array of record objects. For update/delete: each record must include "Id". For upsert: each record must include the external-id field referenced in `externalIdField`.',
        },
        externalIdField: {
          type: 'string',
          description: 'Required for upsert: the API name of the custom external-id field used to match existing records.',
        },
      },
      required: ['operation', 'objectName', 'records'],
    },
  },
  {
    name: 'salesforce_search_all',
    description:
      'Cross-object search using SOSL. Searches multiple objects at once for text matches. Use when the customer wants to find a name/email/keyword without knowing which object it lives on.',
    inputSchema: {
      type: 'object',
      properties: {
        sosl: {
          type: 'string',
          description:
            'A SOSL FIND statement. Example: "FIND {acme corp} IN ALL FIELDS RETURNING Account(Id,Name), Contact(Id,Name,Email)"',
        },
      },
      required: ['sosl'],
    },
  },
];

export interface ToolCallContext {
  connection: Connection;
}

/**
 * Dispatch a tool call to its handler. Each handler returns a value that
 * gets JSON-serialized into the MCP tool result `content[0].text` field.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext,
): Promise<unknown> {
  switch (name) {
    case 'salesforce_search_objects':
      return searchObjects(args, ctx);
    case 'salesforce_describe_object':
      return describeObject(args, ctx);
    case 'salesforce_query_records':
      return queryRecords(args, ctx);
    case 'salesforce_aggregate_query':
      return aggregateQuery(args, ctx);
    case 'salesforce_dml_records':
      return dmlRecords(args, ctx);
    case 'salesforce_search_all':
      return searchAll(args, ctx);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ───────────────────────── Handlers ─────────────────────────

async function searchObjects(args: Record<string, unknown>, ctx: ToolCallContext) {
  const pattern = String(args.pattern ?? '').toLowerCase();
  if (!pattern) throw new Error('pattern is required');

  const meta = await ctx.connection.describeGlobal();
  type SObjectMeta = (typeof meta.sobjects)[number];
  const matches = meta.sobjects.filter(
    (o: SObjectMeta) =>
      o.name.toLowerCase().includes(pattern) || o.label.toLowerCase().includes(pattern),
  );

  return {
    pattern,
    matchCount: matches.length,
    objects: matches.map((o: SObjectMeta) => ({
      name: o.name,
      label: o.label,
      custom: o.custom,
      queryable: o.queryable,
      createable: o.createable,
      updateable: o.updateable,
      deletable: o.deletable,
    })),
  };
}

async function describeObject(args: Record<string, unknown>, ctx: ToolCallContext) {
  const objectName = String(args.objectName ?? '');
  if (!objectName) throw new Error('objectName is required');

  const meta = await ctx.connection.sobject(objectName).describe();

  type FieldMeta = (typeof meta.fields)[number];
  type PicklistValue = NonNullable<FieldMeta['picklistValues']>[number];
  type ChildRel = (typeof meta.childRelationships)[number];

  return {
    name: meta.name,
    label: meta.label,
    custom: meta.custom,
    fields: meta.fields.map((f: FieldMeta) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      length: f.length,
      nillable: f.nillable,
      updateable: f.updateable,
      createable: f.createable,
      defaultValue: f.defaultValue ?? undefined,
      picklistValues: f.picklistValues?.length
        ? f.picklistValues.map((p: PicklistValue) => ({
            value: p.value,
            label: p.label,
            active: p.active,
          }))
        : undefined,
      referenceTo: f.referenceTo?.length ? f.referenceTo : undefined,
    })),
    childRelationships: meta.childRelationships.map((r: ChildRel) => ({
      relationshipName: r.relationshipName,
      childSObject: r.childSObject,
      field: r.field,
    })),
  };
}

async function queryRecords(args: Record<string, unknown>, ctx: ToolCallContext) {
  const soql = String(args.soql ?? '');
  if (!soql) throw new Error('soql is required');

  const result = await ctx.connection.query(soql);
  return {
    totalSize: result.totalSize,
    done: result.done,
    nextRecordsUrl: (result as { nextRecordsUrl?: string }).nextRecordsUrl,
    records: result.records,
  };
}

async function aggregateQuery(args: Record<string, unknown>, ctx: ToolCallContext) {
  const soql = String(args.soql ?? '');
  if (!soql) throw new Error('soql is required');

  // jsforce uses the same .query() endpoint for aggregates; result rows come
  // back as `AggregateResult` objects.
  const result = await ctx.connection.query(soql);
  return {
    totalSize: result.totalSize,
    done: result.done,
    records: result.records,
  };
}

async function dmlRecords(args: Record<string, unknown>, ctx: ToolCallContext) {
  const operation = String(args.operation ?? '');
  const objectName = String(args.objectName ?? '');
  const records = Array.isArray(args.records) ? (args.records as Record<string, unknown>[]) : [];
  const externalIdField = args.externalIdField ? String(args.externalIdField) : undefined;

  if (!objectName) throw new Error('objectName is required');
  if (!records.length) throw new Error('records must be a non-empty array');

  // jsforce v3 ships typed overloads keyed on a Schema generic; at the gateway
  // proxy layer we don't know the schema at compile time, so we cast through
  // `never` for the DML methods. Runtime validation (presence of Id for
  // update/delete; externalIdField for upsert) lives below.
  const sobject = ctx.connection.sobject(objectName);
  switch (operation) {
    case 'insert':
      return {
        operation,
        objectName,
        results: await sobject.create(records as never),
      };
    case 'update': {
      const missingId = records.findIndex(
        (r) => !(r as { Id?: string }).Id,
      );
      if (missingId !== -1)
        throw new Error(
          `update requires every record to have an "Id" field (missing at index ${missingId})`,
        );
      return {
        operation,
        objectName,
        results: await sobject.update(records as never),
      };
    }
    case 'delete': {
      const ids = records.map((r) => String((r as { Id?: string }).Id ?? '')).filter(Boolean);
      if (ids.length !== records.length)
        throw new Error('delete requires every record to have an "Id" field');
      return { operation, objectName, results: await sobject.destroy(ids) };
    }
    case 'upsert':
      if (!externalIdField)
        throw new Error('upsert requires externalIdField to identify match key');
      return {
        operation,
        objectName,
        externalIdField,
        results: await sobject.upsert(records as never, externalIdField),
      };
    default:
      throw new Error(`Unknown operation: ${operation}. Use insert | update | delete | upsert.`);
  }
}

async function searchAll(args: Record<string, unknown>, ctx: ToolCallContext) {
  const sosl = String(args.sosl ?? '');
  if (!sosl) throw new Error('sosl is required');

  const result = await ctx.connection.search(sosl);
  return {
    searchRecordCount: result.searchRecords?.length ?? 0,
    searchRecords: result.searchRecords ?? [],
  };
}
