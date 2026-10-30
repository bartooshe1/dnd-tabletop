// The map command language, shared by both front ends' tool descriptions.
// Every word is sent to the model on every turn (CI checks the token budget).

export const MAP_GRAMMAR = `Commands split by , ; or newline. A batch is atomic: any error applies nothing.
Cell RxC = row x col, 1x1 top-left. Range RxC..RxC. Size WxH.
<cell|range>-<name>  terrain name sets terrain; any other name is a creature token (bare type gets an id: wolf1; player reuses player1)
<cell|range>-empty (token, else terrain) | -clear (both)
<cell|id> > <cell>  move (>! ignores blocking terrain)
new "Name" WxH | use "Name" | maps | caption <text> | scale 1.5
tok <id> name=Snik hp=7/7|-3|+4 status=prone,poisoned|+prone|-prone side=ally|neutral|hostile glyph=🐺 color=#c33
type <name> glyph=💧 color=#4a6 [blocking] | types
draw [~=water T=table w=wolf] then ASCII rows on following lines (# wall . floor + door @ player, space nothing) until a blank line
load <room> [at RxC] | rooms | save "Name" [with tokens]
gen dungeon|cave|clearing|street WxH [rooms=3 doors=true seed=42] (min 5x5)
init player1=17 wolf1=12 (combat turn order, shown to the player; adds/updates) | init next (pass the turn) | init -wolf1 | init end
Ex: new "Crypt" 20x14, gen dungeon 20x14 rooms=4 (result lists room centers; place tokens next call)
Ex: player1 > 4x8, wolf1 > 5x8, tok wolf1 hp=-6 status=prone
Ex: load tavern, caption Rain on the shutters, 7x6-player, 2x5-barkeep`;
