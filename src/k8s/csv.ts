/*-----------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE file in the project root for license information.
 *-----------------------------------------------------------------------------------------------*/

import * as _ from 'lodash';
import OpenShiftItem from '../openshift/openshiftItem';
import { ClusterExplorerV1 } from 'vscode-kubernetes-tools-api';
import * as common from './common';
import { ClusterServiceVersionKind, CRDDescription, CustomResourceDefinitionKind } from './olm/types';
import { TreeItem, WebviewPanel, window } from 'vscode';
import { vsCommand, VsCommandError } from '../vscommand';
import CreateServiceViewLoader from '../webview/create-service/createServiceViewLoader';
import { DEFAULT_K8S_SCHEMA, getUISchema, randomString, generateDefaults } from './utils';
import { loadYaml } from '@kubernetes/client-node';
import { JSONSchema7 } from 'json-schema';
import { getInstance, OpenShiftObject } from '../odo';
import { CommandText } from '../base/command';
import { getOpenAPISchemaFor } from '../util/swagger';

class CsvNode implements ClusterExplorerV1.Node, ClusterExplorerV1.ClusterExplorerExtensionNode {

    readonly nodeType: 'extension';

    constructor(public readonly crdDescription: CRDDescription, public readonly csv: ClusterServiceVersionKind) {
    }

    getChildren(): Promise<ClusterExplorerV1.Node[]> {
        return;
    }

    getTreeItem(): TreeItem {
        const displayName = this.crdDescription.displayName? this.crdDescription.displayName : '';
        const nameVersion = `${this.crdDescription.name}/${this.crdDescription.version}`;
        const label = displayName ? `${displayName} (${nameVersion})` : nameVersion;
        return {
            label,
            contextValue:  'openshift.resource.csv.crdDescription',
            tooltip: `Name: ${this.crdDescription.name}\nVersion: ${this.crdDescription.version}\nKind: ${this.crdDescription.kind}\nDescription: ${this.crdDescription.description || 'N/A'}`
        }
    }
}

interface K8sCrdNode {
    impl: {
        crdDescription: CRDDescription;
        csv: ClusterServiceVersionKind;
    }
}

export class ClusterServiceVersion extends OpenShiftItem {
    public static command = {
        getCsv: (csvName: string): string => `get csv ${csvName}`,
        getCrd: (crdName: string): string => `get crd ${crdName}`,
        getCreateCommand: (file: string): string => `create -f ${file}`,
        getCurrentUserName: (): CommandText => new CommandText('oc whoami'),
        getCurrentUserToken: (): CommandText => new CommandText('oc whoami -t'),
    };

    public static getNodeContributor(): ClusterExplorerV1.NodeContributor {
        return {
            contributesChildren(parent: ClusterExplorerV1.ClusterExplorerNode | undefined): boolean {
                return parent?.nodeType === 'resource' &&
                    parent?.resourceKind?.manifestKind === 'ClusterServiceVersion';
            },
            async getChildren(parent: ClusterExplorerV1.ClusterExplorerNode | undefined): Promise<ClusterExplorerV1.Node[]> {
                const getCsvCmd = ClusterServiceVersion.command.getCsv((parent as any).name);
                const csv: ClusterServiceVersionKind = await common.asJson(getCsvCmd);
                return csv.spec.customresourcedefinitions.owned.map((crd) => new CsvNode(crd, csv));
            },
        };
    }

    static createFormMessageListener(app: OpenShiftObject, panel: WebviewPanel) {
        return async (event: any) => {
            if (event.command === 'cancel') {
                if (event.changed === true) {
                    const choice = await window.showWarningMessage('Discard all the changes in the form?', 'Yes', 'No');
                    if (choice === 'No') {
                        return;
                    }
                }
                panel.dispose();
            }
            if (event.command === 'create') {
                // add waiting for Deployment to be created using wait --for=condition
                // no need to wait until it is available
                const clusters = await getInstance().getClusters();
                if (clusters.length === 0) {
                    // could be expired session
                    return;
                }

                try {
                    await OpenShiftItem.odo.createService(app, event.formData);
                    window.showInformationMessage(`Service ${event.formData.metadata.name} successfully created.` );
                    panel.dispose();
                } catch (err) {
                    window.showErrorMessage(err);
                    panel.webview.postMessage({action: 'error'});
                }
            }
        }
    }

    // oc delete Database database1

    @vsCommand('clusters.openshift.csv.create')
    static async createNewService(crdOwnedNode: K8sCrdNode): Promise<void> {
        const projects = await getInstance().getProjects();
        const apps = await getInstance().getApplications(projects[0]);
        const app = apps.find(item => item.getName() === 'app');
        return ClusterServiceVersion.createNewServiceFromDescriptor(crdOwnedNode.impl.crdDescription, crdOwnedNode.impl.csv, app);
    }

    static async getAuthToken(): Promise<string> {
        const gcuCmd = this.command.getCurrentUserName();
        const gcuExecRes = await this.odo.execute(gcuCmd, undefined, false);
        if (gcuExecRes.error) {
            throw new VsCommandError(gcuExecRes.stderr, `Cannot get current user name. '${gcuCmd}' returned non zero error code.`);
        }
        const gcutCmd = this.command.getCurrentUserToken();
        const gcutExecRes = await this.odo.execute(gcutCmd, undefined, false);
        if (gcutExecRes.error) {
            throw new VsCommandError(gcuExecRes.stderr, `Cannot get current user name. '${gcutCmd}' returned non zero error code.`);
        }
        return gcutExecRes.stdout.trim();
    }

    static async createNewServiceFromDescriptor(crdDescription: CRDDescription, csv: ClusterServiceVersionKind, application: OpenShiftObject): Promise<void> {
        const getCrdCmd = ClusterServiceVersion.command.getCrd(crdDescription.name);
        let crdResource: CustomResourceDefinitionKind;
        let apiVersion: string;
        try {
            crdResource = await common.asJson(getCrdCmd);
        } catch (err) {
            // if crd cannot be accessed, try to use swagger
        }

        let openAPIV3SchemaAll: JSONSchema7;
        if (crdResource) {
            openAPIV3SchemaAll = crdResource.spec.versions.find((version) => version.name === crdDescription.version).schema.openAPIV3Schema;
            apiVersion = `${crdResource.spec.group}/${crdDescription.version}`;
        } else {
            const clusters = await this.odo.getClusters();
            const token = await this.getAuthToken();
            openAPIV3SchemaAll = await getOpenAPISchemaFor(clusters[0].getName(), token, crdDescription.kind, crdDescription.version);
            const gvk = _.find(openAPIV3SchemaAll['x-kubernetes-group-version-kind'], ({ group, version, kind }) =>
                crdDescription.version === version && crdDescription.kind === kind && group);
                apiVersion = `${gvk.group}/${gvk.version}`;
        }

        const examplesYaml: string = csv.metadata?.annotations?.['alm-examples'];
        const examples: any[] = examplesYaml ? loadYaml(examplesYaml) : undefined;
        const example = examples ? examples.find(item => item.apiVersion === apiVersion && item.kind === crdDescription.kind) : {};
        generateDefaults(openAPIV3SchemaAll, example);
        const openAPIV3Schema = _.defaultsDeep({}, DEFAULT_K8S_SCHEMA, _.omit(openAPIV3SchemaAll, 'properties.status'));
        openAPIV3Schema.properties.metadata.properties.name.default =
            example?.metadata?.name ? `${example.metadata.name}-${randomString()}` : `${crdDescription.kind}-${randomString()}`;

        const uiSchema = getUISchema(
            openAPIV3Schema,
            crdDescription
        );

        const panel = await CreateServiceViewLoader.loadView('Create Service', ClusterServiceVersion.createFormMessageListener.bind(undefined, application));

        panel.webview.onDidReceiveMessage(async (event)=> {
            if(event.command === 'ready') {
                await panel.webview.postMessage({
                    action: 'load', openAPIV3Schema,
                    uiSchema,
                    crdDescription,
                    formData: {}
                });
            }
        });
    }
}