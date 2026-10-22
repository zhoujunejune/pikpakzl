import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFastSignal} from './deepseek-single5-production.mjs';
test('fast signal must be within 5s',()=>{const round=1792626900000;assert.throws(()=>buildFastSignal({round,at:round+5000,tick:{round,at:round+4999,open:5,price:6},decision:{direction:'UP'},providerModel:'deepseek-flash'}));});
