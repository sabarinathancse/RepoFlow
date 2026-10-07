import { Adapter } from './types';
import { codeigniter4 } from './codeigniter4';
import { laravel } from './laravel';
import { django } from './django';
import { fastapi, flask } from './python-web';
import { express } from './express';
import { genericPhp } from './generic-php';
import { generic } from './generic';

/** Every adapter, most specific first. New frameworks register here. */
export const ADAPTERS: Adapter[] = [codeigniter4, laravel, django, fastapi, flask, express, genericPhp, generic];
