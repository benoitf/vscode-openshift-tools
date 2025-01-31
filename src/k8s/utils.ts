/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
/* eslint-disable header/header */

import * as Immutable from 'immutable';
import { JSONSchema7 } from 'json-schema';
import * as _ from 'lodash';

import { SpecCapability, Descriptor } from './olm/types';

export enum JSONSchemaType {
    string = 'string',
    number = 'number',
    integer = 'integer',
    boolean = 'boolean',
    null = 'null',
    array = 'array',
    object = 'object',
}

export const DEFAULT_K8S_SCHEMA: JSONSchema7 = {
  type: JSONSchemaType.object,
  properties: {
    metadata: {
      type: JSONSchemaType.object,
      properties: {
        namespace: { type: JSONSchemaType.string },
        name: {
          type: JSONSchemaType.string,
          default: 'example',
        },
        labels: {
          type: JSONSchemaType.object,
          properties: {},
          additionalProperties: { type: JSONSchemaType.string },
        },
      },
      required: ['name'],
    },
    spec: { type: JSONSchemaType.object },
    apiVersion: { type: JSONSchemaType.string },
    kind: { type: JSONSchemaType.string },
  },
};

export const HIDDEN_UI_SCHEMA = {
    'ui:widget': 'hidden',
    'ui:options': { label: false },
};

// Applies a hidden widget and label configuration to every property of the given schema.
// This is useful for whitelisting only a few schema properties when all properties are not known.
export const hideAllExistingProperties = (schema: JSONSchema7) => {
  return _.reduce(
    schema?.properties,
    (acc, _unused, propertyName) => ({
      ...acc,
      [propertyName]: HIDDEN_UI_SCHEMA,
    }),
    {},
  );
};

// Transform a path string to a JSON schema path array
export const stringPathToUISchemaPath = (path: string): string[] =>
  (_.toPath(path) ?? []).map((subPath) => {
    return /^\d+$/.test(subPath) ? 'items' : subPath;
  });

// Recursive helper for getSchemaAtPath
const recursiveGetSchemaAtPath = (
    schema: JSONSchema7,
    [segment, ...path]: string[] = [],
  ): JSONSchema7 => {
    if (segment) {
      return /^\d+$/.test(segment)
        ? recursiveGetSchemaAtPath(schema?.items as JSONSchema7, path)
        : recursiveGetSchemaAtPath(schema?.properties?.[segment] as JSONSchema7, path);
    }
    return schema;
  };

// Get a schema at the provided path string.
export const getSchemaAtPath = (schema: JSONSchema7, path: string): JSONSchema7 => {
    return recursiveGetSchemaAtPath(schema, _.toPath(path));
};

// Map a set of spec descriptors to a ui schema
export const descriptorsToUISchema = (
  descriptors: Descriptor<SpecCapability>[],
  jsonSchema: JSONSchema7,
) => {
  const uiSchemaFromDescriptors = _.reduce(
    descriptors,
    (uiSchemaAccumulator, descriptor, index: number) => {
      const schemaForDescriptor = getSchemaAtPath(jsonSchema, descriptor.path);
      if (!schemaForDescriptor) {
        // eslint-disable-next-line no-console
        console.warn(
          '[OperandForm] SpecDescriptor path references a non-existent schema property:',
          descriptor.path,
        );
        return uiSchemaAccumulator;
      }

      const uiSchemaPath = stringPathToUISchemaPath(descriptor.path);
      if (descriptor.displayName){
        schemaForDescriptor.title = descriptor.displayName;
      }
      return uiSchemaAccumulator.withMutations((mutable) => {
        mutable.mergeDeepIn(
          uiSchemaPath,
          Immutable.Map({
            ...(descriptor.description && { 'ui:description': descriptor.description }),
            ...(descriptor.displayName && { 'ui:title': descriptor.displayName }),
            'ui:sortOrder': index + 1,
          }),
        );
      });
    },
    Immutable.Map(),
  ).toJS();
  return uiSchemaFromDescriptors;
};

function camelCaseToTitle(name: string): string {
    return name.replace(name.charAt(0),name.charAt(0).toLocaleUpperCase()).match(/[a-z]+|[A-Z][a-z]+/g).join(' ');
}

function generateTitlesForSchema(uiSchema, schema): void {
    Object.keys(schema.properties ? schema.properties : {}).forEach((name) => {
        const schemaProperty = schema.properties[name];
        if (schemaProperty.type === 'object') {
            if (!uiSchema[name]) {
                uiSchema[name] = {};
            }
            if (schemaProperty.properties) {
                generateTitlesForSchema(uiSchema[name], schemaProperty);
            } else {
                uiSchema[name]['ui:widget'] = 'hidden';
            }
        } else {
            if (!uiSchema[name]) {
                uiSchema[name] = {};
            }
            if (schemaProperty.type === 'boolean' && !schemaProperty.title) {
                schemaProperty.title = camelCaseToTitle(name);
                schemaProperty.default = false;
            } else if (!uiSchema[name]['ui:title']) {
                uiSchema[name]['ui:title'] = camelCaseToTitle(name);
            }
        }
    });
}

function hideEmptyNodesForSchema(uiSchema, schema): void {
    Object.keys(schema.properties ? schema.properties : {}).forEach((name) => {
        const schemaProperty = schema.properties[name];
        if (schemaProperty.type === 'object') {
            if (schemaProperty.properties) {
                if (!uiSchema[name]) {
                    uiSchema[name] = {};
                }
                hideEmptyNodesForSchema(uiSchema[name], schemaProperty);
            } else {
                uiSchema['ui:widget'] = 'hidden';
            }
        }
    });
}

export function generateDefaults(jsonSchema, jsonData) {
    if (jsonSchema.properties) {
        Object.keys(jsonData).forEach(key => {
            const nextValue = jsonData[key];
            if(typeof nextValue === 'object' && nextValue !== null && !Array.isArray(nextValue)) {
                if (!jsonSchema.properties[key]) {
                    jsonSchema.properties[key] = {};
                }
                generateDefaults(jsonSchema.properties[key], jsonData[key]);
            } else {
                if (nextValue !== undefined && jsonSchema.properties[key]) {
                    jsonSchema.properties[key].default = nextValue;
                }
            }
        });
    }
}

export function randomString(): string {
    return _.sampleSize(_.toArray('abcdefghijklmnopqrstuvwxyz0123456789'), 5).join('');
}

// Use jsonSchema, descriptors, and some defaults to generate a uiSchema
export const getUISchema = (jsonSchema, providedAPI) => {
  const hiddenMetaPropsUiSchema = hideAllExistingProperties(jsonSchema?.properties?.metadata as JSONSchema7);
  const specUiSchema = descriptorsToUISchema(providedAPI?.specDescriptors, jsonSchema?.properties?.spec)
  // Extend ui-schema by adding ui:title for properties without descriptor.
  generateTitlesForSchema(specUiSchema, jsonSchema?.properties?.spec);
  hideEmptyNodesForSchema(specUiSchema, jsonSchema);
  return {
    apiVersion: {
        'ui:widget': 'hidden'
    },
    kind: {
        'ui:widget': 'hidden'
    },
    metadata: {
      ...hiddenMetaPropsUiSchema,
      name: {
        'ui:title': 'Name',
      },
      labels: {
        'ui:title': 'Labels',
        'ui:field': 'Labels',
      },
      'ui:options': {
        label: false,
      },
      'ui:order': ['name', 'labels', '*'],
    },
    spec: {
      'ui:description': '', // hide description for spec
      ...specUiSchema,
      'ui:options': {
        label: false,
      },
    },
    'ui:order': ['metadata', 'spec', '*'],
    'ui:options': {
       label: false,
    },
  };
};
