/*-----------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE file in the project root for license information.
 *-----------------------------------------------------------------------------------------------*/

import { ComponentMetadata } from './config';

export interface Service {
    kind: 'Service';
    apiVersion: string;
    metadata: ComponentMetadata;
    spec: {
        planList: string[];
    };
    [index: string]: any;
}

export interface ServiceOperatorShortInfo {
    name: string;
    version: string;
    displayName: string;
    description: string;
}