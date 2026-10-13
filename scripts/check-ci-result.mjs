const { SELECT, PACKAGE, NATIVE, SUITE, NEED_NATIVE } = process.env;
const valid = SELECT === 'success' && ['none', 'report', 'full'].includes(SUITE) &&
  PACKAGE === (SUITE === 'none' ? 'skipped' : 'success') &&
  ['true', 'false'].includes(NEED_NATIVE) && NATIVE === (NEED_NATIVE === 'true' ? 'success' : 'skipped');
if (valid) console.log(SUITE === 'none' ? 'No applicable package tests: documentation-only change.' : `Selected ${SUITE} checks passed.`);
else console.error('Selected checks did not complete successfully.', { SELECT, PACKAGE, NATIVE, SUITE, NEED_NATIVE });
process.exitCode = valid ? 0 : 1;
