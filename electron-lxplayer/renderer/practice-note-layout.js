(function(root){
 'use strict';
 const letters='CDEFGAB',natural=[0,2,4,5,7,9,11];
 function spellPitch(value,key){
  const midi=Math.round(value),pc=((midi%12)+12)%12,expected=Array(7).fill(0),scale=key?.mode==='minor'?[0,2,3,5,7,8,10]:natural;
  if(key)for(let i=0;i<7;i++){const l=(key.letter+i)%7;let a=(key.pc+scale[i]-natural[l]+24)%12;if(a>6)a-=12;expected[l]=a}
  const direction=Math.sign(expected.reduce((sum,a)=>sum+a,0));let best=null;
  for(let l=0;l<7;l++){let a=(pc-natural[l]+12)%12;if(a>6)a-=12;if(Math.abs(a)>2)continue;const cost=Math.abs(a-expected[l])*4+Math.abs(a)*.3+(Math.abs(a)>1?3:0)+(direction&&a*direction<0?.2:0);if(!best||cost<best.cost)best={l,a,cost}}
  // Spell the octave from the natural letter, including B#/Cb across C boundaries.
  const octave=Math.floor((midi-best.a-natural[best.l])/12)-1;
  return letters[best.l].toLowerCase()+(best.a>=0?'#'.repeat(best.a):'b'.repeat(-best.a))+'/'+octave;
 }
 // Restore the preceding display quantization. Fine-grid fitting was rejected:
 // retaining every raw region does not establish a readable or accurate score.
 function quantizeBar(bar,notes){
  const subdivision=4,count=bar.beats.length*subdivision,cells=Array(count).fill(null),points=bar.beats.map(b=>b[0]).concat(bar.end);
  const units=time=>{const i=points.findIndex((v,j)=>j<points.length-1&&time>=v&&time<points[j+1]);return i<0?(time>=bar.end?count:0):subdivision*(i+(time-points[i])/(points[i+1]-points[i]))};
  notes.forEach((n,id)=>{if(n[1]<=bar.start||n[0]>=bar.end)return;const a=Math.max(0,Math.min(count-1,Math.round(units(n[0])))),z=Math.min(count,Math.max(a+1,Math.round(units(n[1]))));for(let u=a;u<z;u++)cells[u]={id,n}});
  return {cells,subdivision};
 }
 root.FlowavePracticeNoteLayout={spellPitch,quantizeBar};
})(window);
