String.prototype.replaceAll = String.prototype.replaceAll || function (str, newStr) {
    if (Object.prototype.toString.call(str).toLowerCase() === '[object regexp]') return this.replace(str, newStr);
    return this.replace(new RegExp(str, 'g'), newStr);
};
