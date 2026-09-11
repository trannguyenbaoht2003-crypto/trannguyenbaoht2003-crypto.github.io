import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAiAutomationConfig } from '../src/ai-automation-config.js';
const base = { DATABASE_URL: 'postgres://example', REDIS_URL: 'redis://example' };
test('autonomous defaults disabled and ignores unused provider configuration', () => {
    const config = parseAiAutomationConfig({ ...base, OPENAI_API_KEY: ' invalid ' });
    assert.equal(config.autonomousPublicationEnabled, false);
    assert.equal(config.reviewProviderConfig, undefined);
});
test('autonomous requires exact flag and validated provider key and model', () => {
    for (const value of ['TRUE', '', '1'])
        assert.throws(() => parseAiAutomationConfig({ ...base, AI_AUTONOMOUS_PUBLICATION_ENABLED: value }), /CONFIG_INVALID/);
    for (const extra of [{}, { OPENAI_API_KEY: 'key' }, { OPENAI_API_KEY: ' key ', AI_AUTONOMOUS_OPENAI_MODEL: 'model' }, { OPENAI_API_KEY: 'key', AI_AUTONOMOUS_OPENAI_MODEL: 'bad model' }]) {
        assert.throws(() => parseAiAutomationConfig({ ...base, AI_AUTONOMOUS_PUBLICATION_ENABLED: 'true', ...extra }), /CONFIG_INVALID/);
    }
});
test('autonomous and discovery modes are independently enabled', () => {
    const autonomous = parseAiAutomationConfig({ ...base, AI_AUTONOMOUS_PUBLICATION_ENABLED: 'true', OPENAI_API_KEY: 'key', AI_AUTONOMOUS_OPENAI_MODEL: 'model' });
    assert.equal(autonomous.autonomousPublicationEnabled, true);
    assert.equal(autonomous.schedulerEnabled, false);
    assert.deepEqual(autonomous.reviewProviderConfig, { apiKey: 'key', model: 'model' });
    const discovery = parseAiAutomationConfig({ ...base, AI_DISCOVERY_SCHEDULER_ENABLED: 'true', AI_DISCOVERY_PROVIDER: 'openai', OPENAI_API_KEY: 'key', AI_DISCOVERY_OPENAI_MODEL: 'discovery' });
    assert.equal(discovery.autonomousPublicationEnabled, false);
    assert.equal(discovery.schedulerEnabled, true);
});
