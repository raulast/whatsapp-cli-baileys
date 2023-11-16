const { Boom } = require("@hapi/boom");
const { 
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeWASocket,
  makeCacheableSignalKeyStore,
  DisconnectReason, 
  Browsers,
  proto,
} = require("@whiskeysockets/baileys");
const { JsonDB, Config } = require("node-json-db");
const { default: pino } = require("pino");

const dbCli = new JsonDB(new Config("db/client.json", true, true, '/'));
const dbBot = new JsonDB(new Config("db/bot.json", true, true, '/'));
const back_id = "@s.whatsapp.net"
const mass_id = 202311160525;
const mass_msj = {
  text: "Hola {{nombre}}!, este es un mensaje masivo de prueba. \nDeseas seguir recibiendo este tipo de mensajes:\n\n *1* - SI\n\n *2* - NO"
}
const mass_conf = {
  sent:false,
  activate_bot:true,
  bot_id:"titan",
  context:[]
}
const numbers_to_send = [
  {country_code:57,number:3184969134, nombre: "agro-crack"},
  {country_code:57,number:3184969134, nombre: "agro-crack"},
  {country_code:57,number:3184969134, nombre: "agro-crack"},
  {country_code:57,number:3184969134, nombre: "agro-crack"},
  {country_code:57,number:3184969134, nombre: "agro-crack"},
  {country_code:57,number:3184969134, nombre: "agro-crack"}
]

numbers_to_send.forEach(async n=>{
  await dbCli.push(`/${n.country_code}${n.number}`,{
    remote_id:`${n.country_code}${n.number}${back_id}`,
    country_code:n.country_code,
    number:n.number
  },false);
});

const logger = pino({ level: 'debug' });

const _wacli = {};

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)
  const sock = makeWASocket({
    version,
		logger,
    printQRInTerminal: true,
    auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
    generateHighQualityLinkPreview: true,
    browser: Browsers.macOS('Desktop'),
    getMessage
  });
  sock.ev.on ('creds.update', saveCreds)
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const err = new Boom(lastDisconnect.error)
      const shouldReconnect = (err)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log( "connection closed due to :", err, ", reconnecting :", shouldReconnect);
      // reconnect if not logged out
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === "open") {
      console.log("opened connection");
    }
  });
  sock.ev.on("messages.upsert", handleUpsert);
  _wacli.sock = sock;
  sendMasivo(0,74);
}

async function handleUpsert(m) {
  // console.log(JSON.stringify(m, undefined, 2));
  if(!Array.isArray(m.messages)) return;
  const _type = m.type||"";
  if(!["notify"].includes(_type)) return;
  const _m = m.messages.filter(ms_=>
  (
    ms_?.key?.remoteJid && 
    // bot solo para
    ["573184969134"].includes(`${ms_?.key?.remoteJid}`.replace(back_id,'').trim()) &&
    // bot excepto para
    !["status@broadcast"].includes(`${ms_?.key?.remoteJid}`.replace(back_id,'').trim()) &&
    !ms_.key.fromMe
  ));

  if (!(_m.length>0))return;
  const clipath = `/${_m[0].key.remoteJid}`.replace(back_id,'').trim();
  let text = ""
  _m.forEach(mm=>{
    if(mm.message && Object.keys(mm.message)[0]==="extendedTextMessage") {
      text += mm.message.extendedTextMessage.text
    }
  })
  const _text = text;

  // process bot
  await dbCli.reload();
  const cli = await dbCli.getData(clipath);
  if (cli.bot_is_active !== undefined && cli.bot_is_active) {
    await processBot(_text,cli)
    return; 
  }

  // comand test ##hi!
  if(_text === '##hi!')await send(m.messages[0].key.remoteJid, {text: "Hello there!"});
}

function processMessage(text="", vars={}){
  var _text = text
  text.match(/\{\{(.+?)\}\}/g).forEach(m=>{
    _text = _text.replace(m,vars[m.replace(/\{|\}/g,'')]||'-')
  })
  return _text
}

async function processBot(msg,cli){
  await dbBot.reload();
  const bot = await dbBot.getData(`/${cli.bot_id_active}`);
  const contex = cli.bot_context.length >0?cli.bot_context:null;
  const _nodos = bot.filter((b)=>{
    let result =(b.context === contex || (b.context && contex.includes(b.context)));
    if(!b.use_regexp_trigger){
      result = result && b.key_words.includes(msg.toLowerCase());
    } 
    return result;
  });
  if(!_nodos.length>0)return;
  const _nodo = _nodos.sort((a,b)=>(a.hierarchy-b.hierarchy))[0];
  const {responses,actions} = _nodo
  for (let i = 0; i < responses.length; i++) {
    const p = responses[i];
    await send(cli.remote_id,p);
  }
  for (let i = 0; i < actions.length; i++) {
    const {type} = actions[i];
    switch (type) {
      case 'update_model':
        const {config} = actions[i];
        const {
          model, path, var_name, new_var_value
        } = config;
        const mod = getModel(model);
        mod.push(`${processMessage(path,{...cli})}/${var_name}`,new_var_value)
        
        break;
    
      default:
        break;
    }
  }
  return
}
function getModel(model){
  let result = null
  switch (model) {
    case 'client':
        result = dbCli;
      break;
  }
  return result;
}
async function activateBot(cli="",activate,bot_id,bot_context=[]){
  await dbCli.push(`/${cli.replace(back_id,'').trim()}`,{
    bot_is_active:activate,
    bot_id_active:activate?bot_id:null,
    bot_context:activate?bot_context:[]
  },false);
}
async function suscribe(cli="",masive_suscription){
  await dbCli.push(`/${cli.replace(back_id,'').trim()}`,{masive_suscription},false);
}
function sendMasivo(index=0, caller= ""){
  if(!numbers_to_send[index]){
    console.log("masivo procesado!->index: ",index," caller: ",caller)
    return
  };
  const n = numbers_to_send[index]
  setTimeout(async ()=>{
    await dbCli.reload();
    const cli = await dbCli.getData(`/${n.country_code}${n.number}`);
    if(cli.masive_suscription !== undefined && !cli.masive_suscription) {sendMasivo(index+1,123);return;}
    if(cli[mass_id] !== undefined && cli[mass_id].sent ) {sendMasivo(index+1,124);return;}
    await send(cli.remote_id,{
      ...mass_msj,
      text:processMessage(mass_msj.text,{...n,...cli})
    });
    await dbCli.push(`/${n.country_code}${n.number}/${mass_id}`,{...mass_conf,sent:true},false);
    if(mass_conf.activate_bot){
      activateBot(`${n.country_code}${n.number}`,true,mass_conf.bot_id,mass_conf.context)
    }
    sendMasivo(index+1,131)
  },index===0?5000:1000)
}
async function send(id,p,q=undefined){
  const sentMsg = await _wacli.sock.sendMessage(id,p,q);
  return sentMsg;
}
async function getMessage(key = {}) {
  if(store && key.remoteJid && key.id) {
    const msg = await store.loadMessage(key.remoteJid, key.id)
    return msg?.message || undefined
  }

  return proto.Message.fromObject({})
}

// run in main file
connectToWhatsApp();