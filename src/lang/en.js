// English: the source language. Every other file in this folder carries the same keys.
// {x} marks a value filled in at run time; <b> marks a highlighted key name.
export default {
  // HUD
  'hud.score': 'Score', 'hud.wave': 'Wave', 'hud.enemiesLeft': '{n} enemies left', 'hud.health': 'HP', 'hud.grenades': 'Grenades',
  'hud.reloading': ' Reloading…', 'hud.combo': 'Combo x{n}', 'hud.katana': 'Katana', 'hud.grapple': 'Grapple', 'hud.drawReady': 'Ready',
  // key names that are words rather than keycaps
  'key.focus': 'both mouse buttons (or X)', 'key.wheel': 'Wheel', 'key.mouse': 'Mouse', 'key.bothButtons': 'LMB + RMB',
  // controls card
  'ctl.head': 'Mouse + Keyboard', 'ctl.move': 'Move', 'ctl.look': 'Look', 'ctl.sprint': 'Sprint', 'ctl.fire': 'Fire / slash',
  'ctl.aim': 'Aim / block', 'ctl.jump': 'Jump · again in the air to double jump', 'ctl.slide': 'Slide · air dash',
  'ctl.grapple': 'Grapple · hold to reel in', 'ctl.quickSlash': 'Quick katana slash', 'ctl.reload': 'Reload',
  'ctl.grenade': 'Grenade · hold to throw further', 'ctl.switch': 'Switch weapon', 'ctl.focus': 'Dash slash when charged',
  'ctl.board': 'Scoreboard (online)', 'ctl.pause': 'Pause',
  // weapons
  'wpn.rifle': 'Rifle', 'wpn.rifle.hint': 'Full auto · keep the red dot on them',
  'wpn.shotgun': 'Shotgun', 'wpn.shotgun.hint': 'Pump action · brutal up close',
  'wpn.sniper': 'Sniper', 'wpn.sniper.hint': 'Bolt action · one shot, one erase',
  'wpn.revolver': 'Revolver', 'wpn.revolver.hint': 'Hand cannon · headshots erase',
  'wpn.katana': 'Katana', 'wpn.katana.hint': 'Slash · hold aim to block and deflect bullets',
  'wpn.grenade': 'Grenade', 'wpn.deflect': 'their own bullet',
  // enemies
  'foe.grunt': 'Grunt', 'foe.rusher': 'Rusher', 'foe.heavy': 'Heavy', 'foe.sniper': 'Sniper', 'foe.shield': 'Shield Bearer',
  'foe.bomber': 'Ink Bomb', 'foe.flyer': 'Paper Wasp', 'foe.boss': 'Doodle King', 'foe.eraser': 'Eraser King', 'foe.inkblot': 'Inkblot King',
  // maps
  'map.label': 'Map', 'map.district': 'Doodle District', 'map.district.blurb': 'Streets, rooftops and fire escapes',
  'map.mexico': "Doodle Plaza", 'map.mexico.blurb': "Sunny square · market stalls and a fountain",
  // score labels and feed
  'pts.shieldBreak': 'Shield broken', 'pts.perfectParry': 'Perfect parry', 'pts.block': 'Blocked', 'pts.yank': 'Yanked down',
  'pts.pinata': 'Piñata', 'pts.headshot': 'Headshot', 'pts.cleanCut': 'Cut in two', 'pts.slashed': 'Slashed',
  'pts.executed': 'Executed', 'pts.returned': 'Return to sender', 'pts.fell': 'Fell off the page', 'pts.air': ' · Airborne',
  'pick.ammo': '+Ammo · +Grenade', 'pick.taco': 'Taco · +35 HP', 'pick.health': '+35 HP',
  // tips during play
  'tip.deflected': 'Deflected back', 'tip.bounced': 'Bounced off', 'tip.blocked': 'Blocked', 'tip.ropeCut': 'Rope cut',
  'tip.winded': 'Out of breath · land to recover', 'tip.grappleRest': 'The grapple needs a breather',
  'tip.focusReady': '<b>Slash ready</b> · hold {key} to dash', 'tip.dashBlocked': 'Blocked · the dash missed',
  'tip.spawnShield': 'Spawn shield · 2 s', 'tip.yourRopeCut': 'Your rope was cut', 'tip.holdBoard': 'Hold <b>{key}</b> for the scoreboard',
  'tip.musicOn': 'Music on', 'tip.musicOff': 'Music off', 'tip.clickLock': 'Click the screen to capture the mouse',
  'tip.reel': 'Hold <b>{key}</b> to reel in · press again mid-swing to let go',
  'tip.block': 'Block with <b>{key}</b> · some bullets bounce back',
  'tip.air': 'Air kills score more · stay off the ground',
  'tip.grenade': '<b>{key}</b> throws a grenade · pickups refill them',
  'tip.double': 'Press <b>{key}</b> again in the air to double jump',
  // waves
  'wave.n': 'Wave {n}', 'wave.boss': '{name} is coming', 'wave.first': 'They are crawling in from off the page',
  'wave.f1': 'Draw harder', 'wave.f2': 'Keep on doodling', 'wave.f3': 'Stay off the ground', 'wave.f4': 'Bring the blade', 'wave.f5': 'Send the bullets back',
  'mod.caffeine': 'Caffeine · they move faster', 'mod.heavyInk': 'Heavy ink · they hit harder', 'mod.swarm': 'Swarm · more of them, but frailer',
  'wave.checkpoint': 'Checkpoint · Wave {n}', 'wave.next': 'Next wave in {n} s', 'wave.cleared': 'Wave {n} cleared', 'wave.breath': 'Catch your breath · +{pts}',
  'fell.title': 'Fell off the page', 'fell.sub': 'Redrawn at the start',
  // deaths and respawn
  'death.by': 'Erased by {name}', 'death.erased': 'Erased', 'death.headshot': ' headshot', 'death.soon': 'Back in action soon',
  'death.ready': 'Ready', 'death.press': 'Press {key} · any key or click to respawn',
  // online feed
  'feed.erasedName': 'Erased {name}', 'feed.erased': '{killer} erased {victim}', 'feed.fell': '{name} fell off the page',
  'feed.fellMinus': '{name} fell off the page · -1', 'feed.youFell': 'Fell off the page · -1 kill',
  'feed.joined': '{name} joined', 'feed.left': '{name} left', 'feed.lost': '{name} lost connection', 'feed.codeBack': 'Lobby code {code} restored',
  'who.someone': 'Someone', 'who.you': 'you', 'who.youTag': ' (you)',
  'host.left': 'The host left', 'host.leftLobby': 'The host left the lobby', 'host.youNow': 'You are the host now', 'host.moving': 'Moving to the new host…',
  'host.cantTake': 'Could not take over the lobby', 'host.lostMatch': 'The host left and the match was lost',
  'idle.title': 'Still there?', 'idle.sub': 'Move, or you will be removed for being idle', 'idle.closed': 'Lobby closed: everyone was idle',
  'idle.kicked': 'Removed for being idle', 'kick.removed': 'Removed from the lobby',
  // free for all
  'ffa.name': 'Free-for-all', 'ffa.firstTo': 'First to {n} kills', 'ffa.kd': '{k} kills · {d} deaths',
  'ffa.foot': 'First to {n} kills · {t} left · Lobby {code}', 'ffa.win': 'You win', 'ffa.wins': '{name} wins', 'ffa.backSoon': 'Back to the lobby in a moment…',
  'ffa.timerWait': 'The clock starts when someone joins', 'ffa.joinedLate': 'You joined a match in progress',
  'ffa.rules': 'First to {n} kills · {m} min · everyone is a target',
  // network status and errors
  'net.searching': 'Looking for open lobbies…', 'net.found': 'Found {n} open lobbies…', 'net.creating': 'Creating a lobby…',
  'net.connecting': 'Connecting…', 'net.noneOpening': 'No open lobbies · opening a public one for you…', 'net.askStart': 'Asking the host to start…',
  'net.enterCode': 'Enter the lobby code your friend gave you',
  'err.generic': 'Something went wrong', 'err.lib': 'Could not load the networking library · check your connection and reload',
  'err.server': 'Could not reach the matchmaking server · check your connection', 'err.noCode': 'No lobby has that code · check it with your friend',
  'err.noAnswer': 'Found the lobby but could not connect · one of you may be on a network that blocks direct connections',
  'err.full': 'That lobby is full · try another code', 'err.leaveFirst': 'Leave your current lobby first',
  // settings
  'set.sens': 'Mouse sensitivity', 'set.invert': 'Invert vertical look', 'set.music': 'Music', 'set.lang': 'Language',
  'set.quality': 'Graphics', 'q.auto': 'Auto', 'q.high': 'High', 'q.med': 'Medium', 'q.low': 'Low',
  'set.style': 'Style', 'style.marker': 'Marker', 'style.ballpoint': 'Ballpoint',
  'cp.label': 'Checkpoints',
  // main menu
  'intro.click': "Click to play", 'coach.move': "Move", 'coach.shoot': "Shoot", 'coach.grapple': "Grapple · aim at a wall or roof", 'coach.skip': "{key} to skip", 'coach.done': "Nice · now survive the waves",
  'acct.login': "Log in with CrazyGames", 'acct.nameLocked': "Your CrazyGames account name",
  'ad.revive': "Watch an ad to revive", 'ad.restart': "Start over", 'ad.loading': "Loading ad…", 'ad.failed': "The ad didn't play · please try again later", 'ad.adblock': "Ad blocker on · reviving with an ad isn't available", 'ad.revived': "Revived!", 'ad.continue': "Click (or press {key}) to keep going →",
  'inv.copy': "Copy invite link", 'inv.copied': "Invite link copied · send it to your friends", 'inv.manual': "Copy this link and send it to your friends: {link}", 'inv.joining': "Joining your friend's lobby…",
  'dev.needKb': "This game needs a keyboard and mouse", 'tip.platformMuted': "Sound is off in your CrazyGames settings", 'on.privacy': "Online play connects you directly to other players, so they can see your IP address.",
  'menu.tagline': 'A doodle-style survival shooter', 'menu.start': 'Play', 'menu.startSub': 'Solo · hold off wave after wave',
  'menu.online': 'Online', 'menu.onlineSub': "Online hall · drop in any time · up to 10 players", 'menu.best': 'Best: {n}', 'menu.main': 'Main menu',
  // online screens
  'on.sub': 'Free-for-all · first to {n} kills · up to 10 players', 'on.name': 'Your name', 'on.quick': 'Quick match',
  'on.quickHint': 'Joins an open public lobby, or opens one for you', 'on.or': 'or', 'on.create': 'Create lobby',
  'on.public': 'Public', 'on.private': 'Private · friends only', 'on.haveCode': 'Have a lobby code?', 'on.code': 'Code', 'on.join': 'Join',
  'on.publicLobbies': 'Public lobbies', 'on.refresh': 'Refresh', 'on.rejoin': 'Rejoin {code}', 'on.back': 'Back',
  'on.searching': 'Searching…', 'on.clickRefresh': 'Click Refresh to find open lobbies', 'on.clickQuick': 'Click Quick match to get into a lobby',
  'on.hostLobby': "{name}'s lobby", 'on.inMatch': ' · in a match', 'on.full': 'Full', 'on.findFailed': 'Search failed: {err}',
  'lob.title': 'Lobby', 'lob.sub': 'Free-for-all · first to {n} kills · {p}/{max} players', 'lob.code': 'Code',
  'lob.publicHint': 'Public lobby: anyone can join through Quick match or with the code',
  'lob.privateHint': "Private lobby: friends enter this code under Play with friends → Join",
  'lob.start': 'Start match', 'lob.leave': 'Leave', 'lob.anyone': 'Anyone can start', 'lob.lateJoin': 'players can still join after it starts',
  'lob.ready': '{n} players ready',
  // pause, start and end screens
  'pause.menu': 'Menu', 'pause.lobbySub': 'Free-for-all · Lobby {code}', 'pause.leaveMatch': 'Leave match', 'pause.title': 'Paused',
  'pause.score': 'Score', 'go.resumeMatch': 'Click anywhere (or press {key}) to keep playing →', 'go.resume': 'Click anywhere (or press {key}) to resume →',
  'go.fight': 'Click anywhere (or press {key}) to start fighting →', 'go.again': 'Click (or press {key}) to draw again →',
  'start.title': 'Match start', 'dead.title': 'Erased', 'dead.stats': 'You survived <b>{w}</b> waves · <b>{k}</b> kills · Score <b>{s}</b>',
  'dead.record': 'New record', 'dead.best': 'Best {n}',
  'name.prefix': 'Doodle',
  'dev.rotate': "Turn your phone sideways to play", 'go.tap': "Tap anywhere to continue →", 'intro.tap': "Tap to play", 'death.tap': "Tap to respawn", 'ctl.touchHead': "Touch controls",
  'menu.friends': "Play with friends · room code", 'hall.title': "Online hall", 'hall.entering': "Entering the online hall…", 'hall.opening': "Opening the hall…", 'hall.failed': "Could not reach the online hall: {err}", 'hall.retry': "Try again", 'hall.busy': "Every hall is full right now, try again in a moment", 'hall.reopening': "Keeping the hall open for you…", 'hall.alone': "Nobody else is here yet", 'hall.aloneSub': "Warm up on a few doodles; the match starts when someone joins", 'hall.fight': "A challenger joined!", 'hall.fightSub': "Free-for-all · first to {n} kills", 'hall.next': "Next round starts in a moment…", 'hall.moving': "Found other players, moving over…", 'on.friendsTitle': "Play with friends", 'on.friendsSub': "Make a private room and send friends the code, or enter theirs", 'on.createPrivate': "Create private room",
};
