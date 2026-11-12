// Queue ticket page (task 007): open the print dialog once the page has rendered; the button reprints.
addEventListener('load', () => {
  document.getElementById('print-again')?.addEventListener('click', () => print());
  print();
});
