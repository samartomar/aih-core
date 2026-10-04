// Exercise a CLI's SIGINT handler inside its child process on every platform.
// Windows cannot reliably deliver a console SIGINT to a spawned pipe child.
const originalOnce = process.once;
process.once = function (event, listener) {
  const registered = originalOnce.call(this, event, listener);
  if (event === 'SIGINT') process.emit('SIGINT');
  return registered;
};
