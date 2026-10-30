(function(root){
  'use strict';
  // A product palette, not a universal musical convention or an energy scale.
  const colors={intro:'#589a91',verse:'#648fcb','pre-chorus':'#b69650',chorus:'#d87986',bridge:'#a386c5',inst:'#67a6ba',outro:'#82958b',silence:'#90969f'};
  root.FlowaveSectionColors={style(label){return {'--section-color':colors[label]||'#90969f'};}};
})(window);
