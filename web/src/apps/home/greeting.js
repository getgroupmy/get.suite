// The hello at the top of Home.
/** "Good morning" before noon, "Good afternoon" until 6pm, then "Good evening". */
export function greeting(d = new Date()) {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
