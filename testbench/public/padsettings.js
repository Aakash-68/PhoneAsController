// "Controller settings" drawer on the gamepad screen: the same settings block as the home Gamepad tab,
// moved into a side drawer so every change can be tried on the pad straight away.
import { $, load, save } from './overlay.js';

const block = $('padSettings'), home = $('view-padinfo'), drawer = $('padDrawer'), body = drawer.querySelector('.pd-body');
let side = load('padDrawerSide', 'right');

function openDrawer() {
  $('hudSheet').classList.add('hidden');
  body.appendChild(block);
  drawer.dataset.side = side;
  drawer.classList.remove('hidden');
}
export function closeDrawer() {
  if (drawer.classList.contains('hidden')) return;
  drawer.classList.add('hidden');
  home.appendChild(block);
}
$('hControls').onclick = openDrawer;
$('pdClose').onclick = closeDrawer;
$('padClose').addEventListener('click', closeDrawer);
// Swap sides so the stick you are testing is never underneath.
drawer.querySelector('header').insertAdjacentHTML('beforeend', '<button id="pdSide" aria-label="Move to the other side">⇄</button>');
$('pdSide').onclick = () => { side = side === 'right' ? 'left' : 'right'; drawer.dataset.side = side; save('padDrawerSide', side); };
