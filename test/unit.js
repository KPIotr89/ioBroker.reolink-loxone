'use strict';

const path = require('path');
const { tests } = require('@iobroker/testing');

// Run unit tests - this tests the adapter startup/shutdown
tests.unit(path.join(__dirname, '..'));
