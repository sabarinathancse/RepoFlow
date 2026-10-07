async function load() {
  const res = await fetch('/api/todos');
  return res.json();
}
document.addEventListener('click', load);
