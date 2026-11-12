(function(){
  function initCarousel(root){
    var track = root.querySelector('.wc-track');
    var slides = Array.prototype.slice.call(root.querySelectorAll('.wc-slide'));
    var dots = Array.prototype.slice.call(root.querySelectorAll('.wc-dot'));
    var index = 0;
    function update(){
      track.style.transform = 'translateX(-' + (index * 100) + '%)';
      dots.forEach(function(d, i){ d.classList.toggle('active', i === index); });
    }
    function go(i){ index = (i + slides.length) % slides.length; update(); }
    var prev = root.querySelector('.wc-prev');
    var next = root.querySelector('.wc-next');
    if (prev) prev.addEventListener('click', function(){ go(index - 1); });
    if (next) next.addEventListener('click', function(){ go(index + 1); });
    dots.forEach(function(d, i){ d.addEventListener('click', function(){ go(i); }); });
    update();
  }
  function initAll(){
    Array.prototype.slice.call(document.querySelectorAll('.wc-simple-carousel')).forEach(initCarousel);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
  else initAll();
})();
