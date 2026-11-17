export function moonshineWorkerFixture({ partial = 'pending fixture', final = 'confirmed fixture' } = {}) {
  return `let session, samples=0;
  self.onmessage=({data})=>{
    if(data.type==='load')postMessage({type:'ready'});
    if(data.type==='start'){session=data.session;samples=0;}
    if(data.type==='fixture-error')postMessage({type:'error',session,message:'Controlled worker failure'});
    if(data.type==='fixture-progress')postMessage({type:'progress',message:'Loading fixture models…'});
    if(data.type==='fixture-partial')postMessage({type:'partial',session,id:data.id,text:data.text});
    if(data.type==='fixture-final')postMessage({type:'final',session,id:data.id,text:data.text});
    if(data.type==='audio'){
      const speaking = data.audio.some(value => Math.abs(value) > 0.001);
      if (speaking) samples+=data.audio.length;
      if (speaking) postMessage({type:'partial',text:${JSON.stringify(partial)},session,id:0});
      postMessage({type:'consumed',session,sequence:data.sequence});
    }
    if(data.type==='stop'){
      if(samples)postMessage({type:'final',text:${JSON.stringify(final)},session,id:0});
      postMessage({type:'stopped',session});
    }
  };`;
}
